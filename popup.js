const api = typeof browser !== 'undefined' ? browser : chrome;

document.getElementById('convert-button').addEventListener('click', () => {
  api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    api.tabs.sendMessage(tabs[0].id, { action: 'convert' });
  });
});
