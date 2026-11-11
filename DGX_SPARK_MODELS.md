# DGX Spark (GB10) — Local Model Guide

**Machine:** `spark-41e1` — NVIDIA DGX Spark, GB10 Grace Blackwell, 128 GB unified LPDDR5x
**Compiled:** 2026-11-10
**Method:** direct inspection of this box + HuggingFace / GitHub / NGC / Docker Hub registry APIs + NVIDIA developer forums. See [Methodology & sourcing](#methodology--sourcing) — read it before trusting any throughput number here.

---

## 1. Verified hardware

| | |
|---|---|
| SoC | NVIDIA GB10 — **compute capability 12.1 (`sm_121` / `121a`)** |
| CPU | aarch64, 20 cores — 10× Cortex-X925 @ 3.9 GHz + 10× Cortex-A725 @ 2.8 GHz |
| Memory | 128 GB LPDDR5x **unified**; `MemTotal` 127,601,160 kB = **121.7 GiB** usable |
| Disk | 3.7 TB NVMe, **3.0 TB free** — never the constraint |
| OS | Ubuntu 24.04.5 LTS, kernel `6.17.0-1014-nvidia` |
| Driver / CUDA | driver **595.91.07**, `nvidia-smi` advertises **CUDA 13.2**; `nvcc` on PATH is **CUDA 13.0.88** ⚠️ toolkit/driver mismatch — matters if you compile |
| Installed stacks | ollama **0.40.16**, Docker **29.6.2** (GPU passthrough **verified working**), nvidia-container-toolkit 1.20.1-1, cuda-toolkit-13-0 |
| Swap | `/swap.img` 16 GB — enabled, good (LMSYS explicitly recommends swap on this box) |

`nvidia-smi` shows `Memory-Usage: Not Supported`. **This is expected**, not a fault — per [NVIDIA's known-issues page](https://docs.nvidia.com/dgx/dgx-spark/known-issues.html), iGPUs have no dedicated framebuffer. It is also the root cause of an open Dynamo bug (#18291) and of engines systematically under-reserving KV cache.

---

## 2. The constraint: bandwidth, not capacity

Everything about model selection on this machine follows from one number.

> **Decode throughput ≈ 230 GB/s ÷ bytes read per token** — and bytes-per-token tracks **active** parameters, not total.

### The real bandwidth figure

NVIDIA's spec says 273 GB/s. **Plan on ~230.** Measured GPU-side, four independent ways:

| method | measured | source |
|---|---|---|
| CUDA copy/triad, 128 MB buffers, idle | **229–230 GB/s** (84% of spec) | forum 367851 |
| Sustained sequential GPU read | **~235 GB/s** (86%) | forum 386823 (owner of 4 FE units) |
| Independent GPU read | **231 GB/s** | [Chips and Cheese](https://chipsandcheese.com/p/inside-nvidia-gb10s-memory-subsystem) |
| Weight-read during live decode | 178 GB/s = 65% of peak; ×1.5 total traffic ≈ 97% of peak → genuinely hardware-bound | PyTorch profiler, forum 367851 |
| DRAM latency | **113 ns** — "outstanding for LPDDR5X" (Strix Halo >140 ns) | Chips and Cheese |

**Open hardware question:** Hot Chips slides show GB10 supporting 9400 MT/s (~300 GB/s), but shipping `dmidecode` reports **8533 MT/s** configured. A ChargerLAB teardown found SK hynix H58G78CK8BX185 parts rated at exactly 8533 — so the gap may be the silicon's real ceiling, not a firmware cap. Unresolved; NVIDIA has not committed to a UEFI option.

### What I measured on this box (and why it is *not* the inference ceiling)

I wrote and ran a STREAM-triad benchmark (C, OpenMP, `CLOCK_MONOTONIC`, footprint well past L2):

| threads | footprint | bandwidth |
|---|---|---|
| 4 | 3.2 GB | 39.4 GB/s |
| 16 | 12.9 GB | 71.8 GB/s |
| 20 | 16.1 GB | **87.3 GB/s** |

**Do not use this number for model sizing.** It measures the **CPU-side** path, and the community finds the CPU physically cannot fill GB10's 256-bit bus: lmbench tops out ~135 GB/s, single-core 38 GB/s (X925) / 26 GB/s (A725). My 87 GB/s is consistent with CPU-side measurements under GPU contention. It says nothing about the GPU's path to unified memory, which is the one that sets tokens/sec.

Reproducible source:

```c
/* stream.c — gcc -O3 -march=native -fopenmp stream.c -o stream */
#include <stdio.h>
#include <stdlib.h>
#include <time.h>
#include <omp.h>
static double now(void){struct timespec ts;clock_gettime(CLOCK_MONOTONIC,&ts);
                        return ts.tv_sec+1e-9*ts.tv_nsec;}
int main(int argc,char**argv){
  int nt=argc>1?atoi(argv[1]):16;
  size_t n=(size_t)256*1024*1024/8;              /* 256 MB per array per thread */
  double *a=malloc(nt*n*8),*b=malloc(nt*n*8),*c=malloc(nt*n*8);
  #pragma omp parallel for num_threads(nt) schedule(static)
  for(long t=0;t<nt;t++)
    for(size_t i=0;i<n;i++){b[t*n+i]=1.0*i;c[t*n+i]=2.0*i;a[t*n+i]=0;}
  for(int rep=0;rep<3;rep++){
    double t0=now();
    #pragma omp parallel for num_threads(nt) schedule(static) collapse(2)
    for(long t=0;t<nt;t++)
      for(size_t i=0;i<n;i++) a[t*n+i]=b[t*n+i]+3.0*c[t*n+i];
    double el=now()-t0;
    printf("  rep%d %.2fs %.1f GB/s\n",rep,el,(double)nt*n*8.0*3.0/el/1e9);
  }
  return 0;
}
```

> ⚠️ **Trap I hit:** first version used `clock()`, which returns *process CPU time* — across 16 threads that overstates elapsed time ~16× and reported a meaningless 5.9 GB/s. Use `clock_gettime(CLOCK_MONOTONIC)`.

### Live decode measurement

Against the running `Qwen3.8-Flash-Next` (FP4, FP8 KV, 262k ctx, `--thinking`, `--parallel 5`), single stream, temp 0:

| requested | generated | wall | t/s |
|---|---|---|---|
| 64 | 64 | 2.79 s | **23.0** |
| 256 | 256 | 12.71 s | **20.2** |
| 1024 | 436 | 45.08 s | 9.7 |

The drop at 1024 is reasoning tokens inflating output length, not a decode regression.

---

## 3. Sparse MoE wins — by a lot

This is the most important fact about the machine. Same harness, same quantization, adjacent size class:

| dense | t/s | MoE, equal-or-larger total | t/s | ratio |
|---|---|---|---|---|
| llama3.1-70B q4_K_M | **4.4** | gpt-oss-120B (~5B active) | **41–59** | ~10× |
| Qwen3-32B q4_K_M | **10.7** | Qwen3-30B-A3B q4_K_M | **89.3** | **8.3×** |
| Gemma-4-31B bf16 (62 GB) | **3.7** | Gemma-4-26B-A4B (49 GB resident) | **23.7** | 6.4× |
| Gemma-4-31B int4 (16 GB) | 10.6 | Gemma-4-26B-A4B | 23.7 | 2.2× |
| Qwen3-32B q4 (prefill 705–762) | — | Qwen3-30B-A3B (prefill **2541**) | — | 3.4× prefill |

**gpt-oss-120B has 1.7× the total parameters of Llama-3.1-70B and runs ~10× faster.** Dense prefill is crippled too, not just decode.

### Check `config.json` before you download

The `architectures` field is a free pre-flight test — `...MoeForConditionalGeneration` (good) vs plain `...ForConditionalGeneration` (dense, slow) for the same download size:

| repo | weights | arch | verdict |
|---|---|---|---|
| `nvidia/Gemma-4-26B-A4B-NVFP4` | 18.8 GB | `Gemma4ForConditionalGeneration` | MoE 26B/**4B** |
| `nvidia/Qwen3.6-35B-A3B-NVFP4` | 23.4 GB | `Qwen3_5MoeForConditionalGeneration` | MoE 35B/**3B** ✅ |
| `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` | 21.6 GB | `NemotronHForCausalLM` | MoE 30B/**3B** |
| `unsloth/Qwen3.8-27B-NVFP4` | 23.4 GB | `Qwen3_5ForConditionalGeneration` | ⚠️ **DENSE** |
| `nvidia/Gemma-4-31B-IT-NVFP4` | 32.6 GB | `Gemma4...` | ⚠️ **DENSE** |

*(The Gemma rows read `Gemma4ForConditionalGeneration` in both cases — the `-A4B` suffix in the name carries the MoE signal there, not the class name. Verify per model.)*

### Speculative decoding (MTP) is a bigger lever than quantization

Verification is nearly free once weights are read anyway:

- Gemma-4-26B-A4B: 30.3 → **54.9 t/s (+81%)** with MTP
- Qwen3.5-122B-A10B: 28.3 → **38.4 t/s (+36%)**
- DeepSeek code: 19.7 → 31.4 t/s

Optimal `num_speculative_tokens` is **1–3**, not 4–6 (per-position acceptance decays 0.84 → 0.60 → 0.39 → 0.27).

> ⚠️ **Any tok/s figure that doesn't state whether MTP was on is not comparable.** And watch the accounting trick: one "51 t/s" headline was 20 decode-steps/s × 1.95 accepted tokens ≈ 38–40 effective t/s wall-clock. Ask for wall-clock.

---

## 4. Current state of this box

### Running right now

| what | detail |
|---|---|
| `qwen38-flash-next-tf` (Docker, image `tensorfold-qwen38:v1.1.4-eab8582`) | `tensorfold-native serve .../nvidia--Qwen3.8-Flash-Next-FP4-Local/snapshots/b9ce18a6… --context 262144 --parallel 5 --max-tokens 32768 --thinking --kv-cache fp8 --vision --vision-max-images 50` — **as root**, bound `0.0.0.0:8888` |
| ollama 0.40.16 | `127.0.0.1:11434` (loopback only ✅). **`ollama ps` empty** — all 95 GB of models idle on disk |

Downloaded (95 GB in `/usr/share/ollama/.ollama/models`):

| model | size | family | params | quant |
|---|---|---|---|---|
| `gpt-oss:latest` | 13.8 GB | gpt-oss | 20.9B | MXFP4 |
| `gpt-oss:120b` | 65.4 GB | gpt-oss | 116.8B | MXFP4 |
| `qwen3.6:latest` | 22.6 GB | `qwen35moe` | 35.5B | Q4_K_M |

### 🔴 Memory is overcommitted

The tensorfold process **grew from 83.2 GB to 97.7 GB during a ~15-minute observation window**, leaving `MemAvailable` as low as 20 GiB.

TensorFold's own measured receipt for **this exact checkpoint and revision** (`nvidia/Qwen3.8-Flash-Next-FP4-Local @ b9ce18a6`) on a 128 GB GB10:

- engine holds **73.2 GiB** + keeps a **12.2 GiB reserve** → ~85 GiB gone before a request
- per-stream KV: 1.21 GiB @ 32K · 4.03 GiB @ 131K · **7.79 GiB @ 262,144**
- their note: *"a 262,144-token stream fitted in only one start of four on this machine"*

**The arithmetic of the current flags:** `--parallel 5` × 7.79 GiB ≈ **39 GiB KV on top of ~85 GiB ≈ 124 GiB**, against a 121.7 GiB pool.

**Recommended:** drop `--context` to 65536 and `--parallel` to 1–2. Both `--vision` (tower replicated on every TP rank) and `--thinking` (adds an MTP head) cost additional resident memory.

### 🔴 No OOM protection — and OOM on GB10 is unusually bad

`earlyoom` and `nohang` are **both not installed**. From a rigorous community operator's [DGX Spark runbook](https://github.com/evanwtf/local-llm/blob/main/docs/dgx-spark-runbook.md):

- When the pool exhausts, **the kernel OOM killer cannot reclaim the GPU allocation, so it kills small daemons instead — `sshd` included — which locks you out. Recovery is a power cycle.** Two documented incidents (2026-09-13, 2026-09-17).
- **`systemd MemoryMax` is NOT a safety net on GB10** — a CUDA allocation isn't charged to the cgroup (measured: 71,776 MiB on the GPU vs 3,762 MiB in the scope's counter). The reflex fix does not work here.
- Working mitigations: `earlyoom` as a system service · a `MemAvailable` watcher that stops the server below ~14 GiB · **`MAX_JOBS=3`** (a JIT `nvcc` build took 44 GiB in 61 s) · a pre-launch memory gate · a 60 s SBSA hardware watchdog.

### 🟠 `tensorfold-native` is not an NVIDIA product

Assumed initially and found otherwise. It is **[`ashhart/TensorFold`](https://github.com/ashhart/TensorFold)** — a third-party Apache-2.0 inference engine written in **Zig**, created **2026-06-19** (~5 months old), 1,721 stars. **NVIDIA's DGX Spark docs and playbooks never mention it.** No third-party security or numerical audit could be found.

Verified on this box:

```
LISTEN 0.0.0.0:8888      ← all interfaces, no auth, root-owned process
LISTEN 127.0.0.1:11434   ← ollama, loopback only
```

Facts worth having:
- **You are on v1.1.4; upstream is v1.2.5** (2026-11-08, ~11 releases ahead). Upstream ships a prebuilt **`tensorfold-1.2.5-linux-aarch64.tar.gz`** — no compile step.
- GB10 requirements: glibc ≥ 2.28, driver **R580+** (CUDA 13.0), fatbins for sm_80/86/120/**121**. Your driver clears this.
- **Consumes:** HF checkpoint directories (safetensors) — MLX affine 4/6/8-bit, NVIDIA ModelOpt **NVFP4**, **FP4-Local**, XSFP4, EXL3/TR3, block FP8.
- **Refuses GGUF outright** — `zig/src/server/gguf_refusal.zig`: *"GGUF serving is coming. Use a supported checkpoint directory for this build."*
- Its NVFP4 / two-rank / vision paths are labelled **experimental, pending independent numerical qualification**.
- Its own docs are honest about losing: a cold 12,001-token prompt takes **~10 s vs the Python engine's 6.7 s**; **no CUDA graphs**.

### 🟠 Two things worth changing

1. **It's a desktop.** OS overhead is the biggest controllable variable on this machine: **2–4 GiB headless** (<1 GiB with `systemctl set-default multi-user.target`) vs **13–20+ GiB with a desktop**. Xorg (179 MiB) + gnome-shell (153 MiB) currently hold GPU memory. There's a documented case of a 103 GB model loading fine until "the system took up 20 GB doing nothing." Operators running large models disable the GUI *and* unplug the monitor.
2. **UEFI: set Display Reserved Memory to Auto** → **~1.5 GB reclaimed** (GB10 firmware carves ~2.1 GiB off the top for display scanout; BIOS-toggleable 2 GB / 4 GB).

---

## 5. Software stack status

| stack | verdict | evidence |
|---|---|---|
| **vLLM** | **best-supported route** | Repo has per-model recipes with a hardware matrix — `recipes/models/Qwen/Qwen3.6-35B-A3B.yaml` contains `hardware: dgx_spark_gb10: verified`. GB10 appears in 22 files. Active GB10 engineering through Nov 2026. v0.33.0 current |
| **NGC containers** | **what NVIDIA tells you to use** | `nvcr.io/nvidia/vllm:26.10-py3` — registry API confirms **multi-arch, amd64 + arm64** |
| vLLM official image | arm64 tags live | `vllm/vllm-openai:nightly-aarch64` (724 tags) |
| **TensorRT-LLM** | officially supported, heaviest | `supported-hardware.md` lists DGX Spark. `nvcr.io/nvidia/tensorrt-llm/release:spark-single-gpu-dev` ⚠️ name suggests dev/staging — UNVERIFIED |
| **llama.cpp** | supported; prebuilt arm64 CUDA now exists | b12243 (2026-11-10), ships `llama-b12243-bin-ubuntu-cuda-13.5-arm64.tar.gz`. NVIDIA's playbook instead says **build from source**: `cmake -B build -DGGML_NATIVE=ON -DGGML_CUDA=ON -DGGML_CURL=ON -DGGML_RPC=ON -DCMAKE_CUDA_ARCHITECTURES=121a-real` |
| **ollama** | easiest, format-limited | GB10 **officially in the support matrix** (`docs/gpu.mdx` row `12.1 / GB10 (DGX Spark)`, PR #13987 merged 2026-01-31). GGUF + MXFP4 only |
| ExLlamaV3 | now builds on GB10 | v1.6.6; PR #393 (aarch64 AVX guard) + #398 (MemAvailable for iGPU) merged 2026-09-21. Multi-node #151 still OPEN |
| Dynamo | targets Spark | #7810 "add GB10 to known SKUs" merged 2026-04-02, but #18291 open — the `NVMLError_NotSupported` from `nvmlDeviceGetMemoryInfo` still bites |

### 🔴 Do not pull ollama's `nvfp4` / `mxfp8` / `mlx` tags

`ollama.com/library/qwen3.6/tags` lists `qwen3.6:35b-a3b-nvfp4` (23 GB), `-mxfp8`, `-mlx`. **These are MLX — macOS only.**

- ollama issue **#16056 "NVFP4 support" is still OPEN** (since 2026-05-09). ollama does **GGUF + MXFP4 only** on CUDA.
- ollama issue **#16019** (closed) is literally "MLX-tagged model refuses to load on Linux Spark — *requires macOS*."

On this box ollama's ceiling is therefore `qwen3.6:35b-a3b-mtp-q4_K_M` (23 GB) and the `gpt-oss` MXFP4 line. The NVFP4 path needs vLLM, TensorRT-LLM, or TensorFold.

### 🟠 NVFP4 is a trap unless you verify the kernel

NVFP4 checkpoints look perfect on paper — native FP4 on GB10 silicon. **SM121 had no working FP4 CUTLASS kernels in vLLM for much of 2026**, so NVFP4 silently falls back to Marlin SM80 and runs *slower than INT4*:

| same weights | wrong kernel | right kernel |
|---|---|---|
| Qwen3.5-122B-A10B | **16.6 t/s** (NVFP4) | **28.3 t/s** (INT4-AutoRound) |
| MiniMax M2.7 | 25 t/s (NVFP4) | 35–40 t/s (AWQ-4bit) |
| worst case | **1.1 t/s** (vanilla vLLM emulation) | **77.1 t/s** (FlashInfer CUTLASS, same weights) |

> Community rule: **"NVFP4 is not a trap, missing kernels are. Check the log line, not the format name."**

llama.cpp handles FP4 more explicitly — `GGML_CUDA_MMQ_PREC=auto|q4|q8`: NVFP4/MXFP4 W4A16 layers request 8-bit activations and run W4A8 on Blackwell rather than native W4A4; `q4` keeps W4A4 for faster prefill at an accuracy cost.

### Known GB10 bugs to plan around

| project | issue |
|---|---|
| ollama | **#17596 OPEN** — deterministic `CUDA illegal memory access` in `flash_attn_ext_mma_f16_case<256,256,8,8>` during **large prefill** on head-size-256 models |
| ollama | **#17434 OPEN** — same crash, `qwen3.6:35b` with JSON-schema `format` + `think:false` |
| ollama | #18442 OPEN — `gemma4:26b` concurrent decode loses EOS |
| llama.cpp | #28132 DeepSeek-V4-Flash deterministic character-level output corruption (closed) |
| llama.cpp | #27871 `qwen4exp` aborts with CUDA `invalid argument` at native 262,144 depth (closed) |
| llama.cpp | #28377 `cublasGemmEx` internal failure during prefill — workaround `-ub 256` |
| vLLM | #66696 / #66719 OPEN — **CPU-tier KV offload broken**, which is exactly the mechanism you'd lean on with unified memory |

**Architecture note:** SM121 ≠ SM120 ≠ SM100. Spark has **99 KB shared memory** (SM100 has 228 KB + 256 KB TMEM), so GEMM tiles are smaller and reload more from an already-saturated bus. Kernels tuned for RTX PRO 6000 (SM120) do not transfer cleanly.

---

## 6. What to install

Rank by active parameters. Sizes are HF safetensors element counts, not marketing numbers.

### Tier 1 — install these, they're fast

| model | total / **active** | ~4-bit | ctx | modal | license | measured |
|---|---|---|---|---|---|---|
| **`google/gemma-4-26B-A4B-it`** | 25.8B / **4B** | **13 GB** | 256K | vision + audio | **apache-2.0** | 23.7 → **54.9 t/s (MTP)** |
| **`Qwen/Qwen3.6-35B-A3B`** | 35.95B / **3B** | 18 GB | 262K | vision | apache-2.0 | 30–40 t/s (FP8+MTP) |
| `zai-org/GLM-4.7-Flash` | 31.2B / **3B** | 16 GB | 198K | text | MIT | — |
| `nvidia/Nemotron-3.5-Lightning-30B-A3B` | 32.9B / **3B** | 16 GB | 256K | text | OpenMDW 1.1 | — |

**Gemma-4-26B-A4B is the single best fit on this machine** — 13 GB, 4B active, 256K, vision *and* audio, and now Apache-2.0 (Gemma's license changed). 8× faster than its dense sibling `gemma-4-31B-it` at comparable download size.

`Qwen3.6-35B-A3B` is what you already have as `qwen3.6:latest` — 35.95B measured (35,951,822,704), 3B activated, 8 routed + 1 shared of 256 experts, hybrid 30-linear/10-full attention, released 2026-04-15.

### Tier 2 — real capability, still fits

| model | total / **active** | ~4-bit | why |
|---|---|---|---|
| **`Qwen/Qwen3-Coder-Next`** | 79.7B / **3B** | 40 GB | **standout** — 80B total at 3B active; successor to Qwen3-Coder-30B-A3B |
| `nvidia/Nemotron-3.5-Bolt-74B-A9B` | 74.9B / **9B** | 37 GB | VLM, 2026-10-09, plus an **official 2-bit build at 24.1 GB** |
| `mistralai/Mistral-Small-4-119B-2603` | 119B / **6.5B** | 60 GB | best capability-per-active-param that fits; Apache-2.0, vision |
| `poolside/Laguna-S-2.1` | 117.6B / **8B** | 59 GB | **1M context**, agentic coding |
| `Qwen/Qwen3.5-122B-A10B` | 125B / **10B** | 63 GB | **use INT4-AutoRound (28.3→38.4 t/s w/ MTP), not NVFP4 (16.6)** |
| `gpt-oss:120b` *(installed)* | 116.8B / ~5B | 65 GB | 41 (ollama) / ~50 (SGLang) / **58–60 (tuned vLLM)** |

Also notable: **`nvidia/Nemotron-3-Nano-Omni-30B-A3B`** — any-to-any **text+image+audio**, Mamba2-hybrid, 33B/3B, 21 GB as NVFP4. And `nvidia/Nemotron-3.5-Super-VL-120B-A12B` (12B active, **1M ctx**) at ~62 GB.

**gpt-oss has no successor** — OpenAI's newest org repo is `privacy-filter`; gpt-oss-20b/120b date to Aug/Sep 2025. Your 120B is still current.

### Edge of possible

**`Qwen/Qwen3.8-Flash-Next`** (2026-08-24) — arch `Qwen4ExpForConditionalGeneration` / `qwen4_exp`. Official card: **125B with 6B activated, plus 51B n-gram embedding and 4B MTP** (180B measured). 512 routed experts, 10+1 active, 48 layers, 262,144 ctx (→1M), vision. License `other` (custom in-repo LICENSE — read before commercial use).

How it fits at all: the official `nvidia/Qwen3.8-Flash-Next-FP4-Local` is **102 GB on disk** — over the ~95 GB ceiling — yet a reproducible recipe reaches **67.5 t/s median** on one Spark because **the 51.2 GB tri-gram n-gram table is streamed from NVMe and never resident** (needs ~200 GB free disk). This is what you're running.

> ⚠️ If that streaming degrades, an operator on the **stock NVMe** reported **0.4 t/s** — "it's pure NVMe I/O, compute sits there waiting for experts." The only drive slot is internal 2242 Gen5.

**DeepSeek-V4-Flash** — the community's default daily driver, but **the official FP4+FP8 mixed checkpoint is 160 GB and cannot fit one Spark.** Two ways it does run: community **EXL3 ~2 bpw at ~78 GB on a single Spark** (1058 pp/s, **52 t/s**), or TP2/TP3 across 2–4 Sparks. At 2 bpw the quality caveat is real — a REAP expert-pruned 3.0 bpw build scored *lower* (84) than a 2 bpw calibrated quant (94), because pruning 40 of 256 experts cost more than the extra bits gave back.

### Rule out entirely — cannot fit at any sane quant

| model | total | why |
|---|---|---|
| `moonshotai/Kimi-K3` / `K3.1-Pro` | **2.8T** (104B active) | 2.72 TB |
| `Qwen/Qwen3.8-2.4T-A95B` | 2,446B | 4.89 TB BF16 |
| `mistralai/Mistral-Large-4-1T-A52B` | ~1T (49B active) | 1.06 TB repo — weights *are* real and ungated |
| `DeepSeek-V4-Pro/-0813` | 1,599–1,651B | 865 GB–1.78 TB |
| `zai-org/GLM-5 / 5.1 / 5.2 / 5.3` | ~753B (40B active) | 756 GB–1.5 TB |
| `thinkingmachines/Inkling` | 952B | ~476 GB |
| `DeepSeek-V3.2` / `V4.1-Flash` | 685B / 763B | 510–689 GB |
| `MiniMaxAI/MiniMax-M3` / `M3.1-Flash` | ~428B | already ~220 GB packed |
| `stepfun-ai/Step-5-Preview` | 600B | 604B, 1M ctx |
| `inclusionAI/Ling-3.1-flash` | 560B | 572B measured |
| `XiaomiMiMo/MiMo-V2.6-Pro-RL` | 1,024B | ~512 GB |
| `nvidia/Nemotron-3-Ultra-550B-A55B` | 560B (55B active) | ~280 GB; runs on 2 Sparks @ 5.2 t/s |
| `tencent/Hy3` | 295B | ~150 GB |
| `upstage/Solar-Open2-250B` | 250B (15B active) | ~125 GB |
| `thinkingmachines/Inkling-Small` | 266B | ~133 GB |
| `zai-org/GLM-5.3-Flash` / `GLM-4.7` | 321B / 358B | ~160 / ~180 GB at 4-bit |

**Exclude these too, despite fitting physically:**

- `mistralai/Mistral-Medium-3.5-128B` — ~64 GB, but **fully dense 127.7B**. Unusable throughput on unified memory.
- `Qwen/Qwen3.6-27B`, `Qwen3.5-27B`, `Qwen3.8-27B`, `gemma-4-31B-it`, `meta-models/Muse-Glimmer-30B`, `NousResearch/Arete-27B` — all **dense**, right-sized download, slow. (`Qwen3.8-27B` is the most-adopted new release at 19.5K likes and reports 34–38 t/s, but that figure exceeds what the bandwidth model allows for a dense 27B — almost certainly MTP. Treat as unverified.)

**Licensing:** Gemma 4 → apache-2.0. NVIDIA Nemotron 3.5 → OpenMDW 1.1. DeepSeek / GLM / Ling → MIT. Qwen3.5/3.6/3.8-27B → apache-2.0, but **Qwen3.8-Flash-Next and Qwen3.8-2.4T are `license: other`** with custom in-repo terms. Kimi and MiniMax → `other`. Mistral Large 4 → modified MIT with a MaaS carve-out.

**One naming trap:** Meta abandoned the Llama name (nothing from `meta-llama` since April 2025). Its open-weights line is now a separate **Verified org, `meta-models`** — `Muse-Glimmer-30B`, `Muse-Spark-Open-816B-A42B`. It reads like an impersonator. It isn't.

---

## 7. Hard limits people hit

**The 8192-token attention cliff.** A measured study of a 744B MoE on one 121 GB box: **0.86 → 0.45 t/s across the T=8192 boundary**, with attention's share of wall time jumping 43% → 70% because the ragged-attention path falls off the GPU above 8192. *"Past 8k your bottleneck isn't experts at all."* Related: `LONG_PREFILL_TOKEN_THRESHOLD=0` **doubled** DeepSeek-V4 prefill (1107 → 2629 t/s) — a default that actively hurts Spark.

**Vision at the sizes you'd want.** DeepSeek-V4-Flash Vision Exp is a **~168 GB checkpoint — doesn't fit one Spark**. Measured elsewhere: Qwen3-VL-235B Q3 **12.9 t/s** on a simple image prompt; GLM-5.2 vision needs **3×** GB10 for 16 t/s. The vision tower is **replicated on every TP rank**.

**KV cache is usually NOT your constraint** at single-user scale — measured 1.25 GB for 64K tokens at f16 on Nemotron-3-Nano-30B-A3B. *"At 64K the KV cache is under 2 GB out of 128 GB. There's no memory pressure to solve."* Quantizing KV bought 0.2 t/s (noise). Pressure comes from **weights + CUDA graphs + activations**, and from *concurrency × context*.

**Two models at once:** only if combined weights + worst-case KV stay under ~95–100 GiB. Realistically **one large FP4 model plus something ≤10–20 GB**, with context capped on both. gpt-oss-120B and Qwen3.5-35B each occupy 65–75 GB in vLLM — *"both can't run simultaneously."*

**Sub-3-bit for agentic work** — q2_K_XS/DwarfStar-class quants *"really struggle with multistep reasoning and long task execution."* Counterpoint people weigh: a 3-bit MiniMax at 10 t/s solved an agentic task in 3 iterations / 11 min that a 3×-faster 30B-A3B thrashed on for 20 min. Quality-per-token is not free.

**Multi-Spark is capacity, not speed.** Over the ConnectX-7 200GbE: Qwen3.5-397B-A17B int4 on 2× Spark → 25–30 t/s; Nemotron-3-Ultra-550B on 2× → **5.2 t/s decode**. **Dual-node is slower per token than single.** Expect ~60–70% scaling on MoE, ~40% on dense TP. `--no-mmap -fit off` is mandatory at those sizes or the load hangs forever at "fitting params to device memory."

**Where Spark is genuinely good: prefill.** 1,000–7,600 t/s across engines; *"prefill is fine because it's compute-bound, which the Spark has plenty of."* ~1 PFLOP NVFP4 2:4 sparse independently measured as real. At 6,000 t/s a 27,000-token prompt costs 3.6 s — so RAG / agents / long-document ingest are this box's strength, *if* you stay under the 8192 cliff. A Mac Studio M4 Max owner: *"sparks are way faster due to prefill… it spanks my Mac."*

**The honest comparison:** an M5 Max 128 GB hits 1,368 pp/s / **66.9 tg/s** on Qwen3.8-Flash-Next-oQ4e-mtp — *better decode than Spark at equal RAM*, much worse prefill. Spark's value is prefill + the CUDA/agent ecosystem + price; its decode ceiling is the LPDDR5X bus and **no software fix exists**.

---

## 8. Concrete plan

1. **Install `earlyoom`** — you currently have no OOM protection, and on GB10 an OOM kills `sshd` and needs a power cycle.
2. **Cap the tensorfold job** — `--context 65536 --parallel 1`. Currently `262144 × 5` ≈ 124 GiB against a 121.7 GiB pool.
3. **Decide about the root `0.0.0.0:8888` endpoint** — unauthenticated third-party engine on all interfaces, on a box also running RustDesk. Bind to loopback or firewall it. Consider updating v1.1.4 → v1.2.5.
4. **Go headless for big-model work** — `systemctl set-default multi-user.target` + UEFI Display Reserved Memory = Auto → **~15–18 GB recovered**.
5. **Install, in order:** `gemma-4-26B-A4B-it` (13 GB) → `Qwen3-Coder-Next` (40 GB) → `Mistral-Small-4-119B` or `Qwen3.5-122B-A10B` (~60–63 GB).
6. **Use containers, not pip** — `nvcr.io/nvidia/vllm:26.10-py3`. Nobody confirmed the PyPI aarch64 wheel contains sm_121 SASS; that's the most decision-relevant unknown here.
7. **Check the kernel line in the engine log** before believing any NVFP4 number.
8. **For your existing `gpt-oss:120b`:** move it out of ollama. 41 → 58–60 t/s comes from CUDA graphs; deleting `--enforce-eager` alone took one user from **26 → 59 t/s**.

**Useful community tooling:** `eugr/spark-vllm-docker` (de facto standard, has recipes) · `azampatti/tool-eval-bench` (the harness most tok/s claims use) · antirez's **ds4/DwarfStar** (CUDA target `make cuda-spark`, `sm_121a`, treats Spark as a primary target and publishes honest *low* numbers) · `evanwtf/local-llm` runbook.

---

## Methodology & sourcing

**What was actually reachable.** All three research streams lost `WebSearch` entirely (`API Error: 400 only client-defined function tools are supported`) and **Reddit was hard-blocked** (403 on `www`/`old` for every user agent; r.jina.ai 403; no working redlib mirror). So this rests on:

- **Primary, strongest:** HuggingFace API (`/api/models?expand=safetensors` for real weight counts, `config.json` for expert topology, `usedStorage` for repo bytes), GitHub REST/search API, PyPI JSON API, Docker Hub + NGC registry APIs (manifest lists pulled directly), ollama registry/API, NVIDIA `docs.nvidia.com` + `build.nvidia.com/spark`
- **Community:** `forums.developer.nvidia.com` (~25 GB10 threads via Discourse JSON API), Chips and Cheese, LMSYS blog, Ollama blog, 3 benchmark repos on GitHub
- **Local:** direct inspection — `nvidia-smi`, `/proc/meminfo`, `ps`, `ss`, `docker`, live OpenAI-compatible completion calls, a self-written STREAM benchmark

**Confidence rules.** Vendor numbers (Ollama's 13-model table, LMSYS) are pinned to specific firmware/driver versions — Ollama's is `580.95.05` / v0.12.6, while late-2026 community numbers run `580.126.09`→`580.173.02`. **Early-2026 and late-2026 figures are not comparable.**

**Deliberately excluded:** DDG results were saturated with AI-content-farm domains publishing fabricated-looking benchmark tables (gpuwerk.com, verdictbits.com, presenc.ai, willitrunai.com, asicmining360.com, spark-arena.com, and ~12 similar). None cited.

**Every tok/s figure in this document is self-reported.** There is **no neutral, third-party, same-hardware head-to-head of GGUF vs NVFP4 vs EXL3 on a Spark.** The entire "TensorFold is 2× vLLM" corpus traces to TensorFold-affiliated or enthusiast repos (a GitHub search returns 248 `tensorfold` repos, many titled "…on 2× DGX Sparks with TensorFold").

**Explicitly UNVERIFIED:**
1. Whether prebuilt `llama-*-cuda-13.5-arm64` runs on driver 595.91.07 (CUDA 13.2 advertised) — no documented minimum driver
2. Whether PyPI `vllm-…-aarch64.whl` contains sm_121 kernels — **the most decision-relevant unknown**
3. The "FP4-Local ≈ 13% smaller than NVFP4" claim (single vendor table)
4. All TensorFold-vs-vLLM speed numbers
5. Whether `tensorrt-llm/release:spark-single-gpu-dev` is a supported product or a staging tag
6. `GLM-4.7` and `MiniMax-M2.7` active-parameter counts (not stated on their cards)
7. Whether ollama's 1.53 GB `ollama-linux-arm64.tar.zst` bundles CUDA libs (inferred from size only)

**Not measured:** download throughput (registry blob needs a bearer-token exchange). Both registries reachable at ~100 ms.

**Also true:** two of the three streams left scratch material in `/tmp` (`/tmp/llmscan/`, `/tmp/tf_*.md`, `/tmp/ssrun.md`) — re-fetch from the URLs rather than trusting any summary in this file.

### Key URLs

```
https://docs.nvidia.com/dgx/dgx-spark/known-issues.html      ← UMA + cudaMemGetInfo guidance
https://build.nvidia.com/spark                                 ← playbooks (vLLM, llama.cpp, SGLang, nvfp4-quantization)
https://github.com/ollama/ollama/blob/main/docs/gpu.mdx        ← GB10 @ 12.1; issues #16056 #17596 #17434 #16019
https://github.com/ggml-org/llama.cpp/releases                 ← b12243, cuda-13.5-arm64 asset; docs/build.md GGML_CUDA_MMQ_PREC
https://github.com/vllm-project/vllm/blob/main/recipes/models/Qwen/Qwen3.6-35B-A3B.yaml   ← dgx_spark_gb10: verified
https://github.com/ashhart/TensorFold                           ← RUNBOOK.md, docs/recipes/flash-next-cuda.md
https://github.com/evanwtf/local-llm/blob/main/docs/dgx-spark-runbook.md   ← the OOM/earlyoom material
https://github.com/DandinPower/llama.cpp_bench/blob/main/dgx_spark/report.md  ← community llama.cpp sweep
https://ollama.com/blog/nvidia-spark-performance                ← vendor prefill/decode table
https://lmsys.org/blog/2025-11-03-gpt-oss-on-nvidia-dgx-spark/
https://chipsandcheese.com/p/inside-nvidia-gb10s-memory-subsystem
https://huggingface.co/nvidia/Qwen3.8-Flash-Next-FP4-Local
```

Containers, registry-verified:
```
nvcr.io/nvidia/vllm:26.10-py3                     (multi-arch amd64 + arm64)
nvcr.io/nvidia/tensorrt-llm/release:spark-single-gpu-dev
vllm/vllm-openai:nightly-aarch64
```
