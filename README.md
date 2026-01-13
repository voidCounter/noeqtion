# Noeqtion — LaTeX to Notion Math Converter
<a style="display: block;" href="https://addons.mozilla.org/en-US/firefox/addon/notion-math-converter" target="_blank">
  <img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" 
       alt="Get the Add-on" width="150"/>
</a>

A browser extension that converts LaTeX-style equations to Notion's native math blocks.
Notion still hasn't implemented automatic equation rendering for pasted text. If you've ever copied notes with mathematical equations into Notion, you know the pain. Those beautiful `$E=mc^2$` expressions just sit there as plain text. This extension fixes that just with a keyboard shortcut.

https://github.com/user-attachments/assets/f872b9ef-1ce1-4ce5-bc26-92bc96a0a116


_See the extension in action converting LaTeX equations to Notion's native math blocks_

## Features

- **Automatic Conversion**: Detects both inline (`$...$`) and block (`$$...$$`) equations.
- **Keyboard Shortcut**: Convert all equations on the page with `Ctrl+Alt+M` (or use the extension popup).

That's it.

## How to Use

1. Install the extension in your browser
2. Open a Notion page with LaTeX equations (like `$O(n)$` or `$$\int_0^\infty e^{-x^2}dx$$`)
3. Press `Ctrl+Alt+M` (or click the extension icon and hit "Convert")
4. Watch your equations transform into Notion's native math format

## Supported Browsers

- **Firefox**: Fully tested and working
- **Chrome**: Fully tested and working
- **Other Chromium-based browsers**: Probably work, but not tested

## Installation
### For Firefox:

<a style="display: block;" href="https://addons.mozilla.org/en-US/firefox/addon/notion-math-converter" target="_blank">
  <img src="https://blog.mozilla.org/addons/files/2020/04/get-the-addon-fx-apr-2020.svg" 
       alt="Get the Add-on" width="150"/>
</a>

### For Chrome:
   - Open `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extension folder

## Technical Notes

The extension uses Notion's existing shortcuts and features to create math blocks. For display equations (`$$...$$`), it uses the `/math` command. For inline equations (`$...$`), it converts them to Notion's inline format by wrapping them as `$$...$$`.

To reduce visual distraction during conversion, the extension temporarily hides math dialogs using injected CSS. It processes equations sequentially, rescanning the DOM after each conversion to handle Notion's dynamic content updates.

The extension doesn't inject custom UI or modify Notion's core behavior. It automates what you'd do manually, just much faster.

## Limitations

This extension works great for standard use cases. But there are some edge cases where it may not work as expected.

If you encounter issues with these or other scenarios, please [open an issue](https://github.com/voidCounter/noeqtion/issues) with details about the specific context where the conversion failed.

## License

Do whatever you want with this code. If it helps you, great. If you improve it, even better.
