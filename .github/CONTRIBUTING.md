# Contributing to Hike GPX Viewer

Thank you for your interest in contributing to the Hike GPX Viewer project!

## Development Setup

```bash
# Clone the repository
git clone https://github.com/DavidPu/hike.git
cd hike

# Install dependencies
npm install

# Start local server
npm start
```

## Project Structure

```
├── app.js              # Main application logic
├── index.html          # Main page
├── style.css           # Styles
├── gpx/                # Sample GPX files
├── pics/               # Sample photos
├── lib/                # Libraries (gmaps2gpx)
├── icons/              # UI icons
└── cloudflare-worker/  # Cloudflare Worker code
```

## Making Changes

1. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature
   ```

2. **Commit your changes**:
   ```bash
   git add .
   git commit -m "feat: Add your feature description"
   ```

3. **Push to GitHub**:
   ```bash
   git push origin feature/your-feature
   ```

4. **Open a Pull Request** on GitHub

## Testing

Before submitting, ensure everything works:
- Start local server: `npm start`
- Test core functionality
- Verify no console errors
- Check mobile responsiveness

## Code Style

- Use semantic HTML
- Keep CSS scoped and organized
- Comment complex JavaScript logic
- Follow existing code patterns

## Feature Ideas

- [ ] Add map layers (satellite, terrain)
- [ ] Export to GPX/KML
- [ ] Import from KML
- [ ] Add route sharing
- [ ] Mobile app version
- [ ] GPX editor
- [ ] Trail analytics

## Reporting Issues

When reporting bugs, please include:
- Browser and version
- Steps to reproduce
- Expected behavior
- Actual behavior
- Screenshots (if applicable)

## License

This project is MIT licensed. See LICENSE file for details.

---

Thanks for contributing! 🥾