const api = typeof browser !== 'undefined' ? browser : chrome;

document.getElementById('convert-button').addEventListener('click', () => {
  api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || !tabs[0]) {
      console.error("No active tab found");
      return;
    }
    api.tabs.sendMessage(tabs[0].id, { action: 'convert' }).catch((err) => {
      console.error("Failed to send message to content script:", err.message);
    });
  });
});
