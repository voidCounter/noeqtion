const api = typeof browser !== 'undefined' ? browser : chrome;
const button = document.getElementById('convert-button');
let resetTimer = null;

function setButtonState(state, result = null) {
  clearTimeout(resetTimer);
  button.className = state;
  button.disabled = state === 'converting';

  const converted = result?.equationsConverted;
  const found = result?.equationsFound;
  const labels = {
    idle: 'Convert',
    converting: 'Converting…',
    complete: Number.isFinite(converted) ? `Done (${converted})` : 'Done',
    partial: Number.isFinite(found) ? `Partial (${converted}/${found})` : 'Partial',
    stopped: Number.isFinite(found)
      ? `Stopped (${converted}/${found})`
      : 'Stopped',
    'no-matches': 'No equations',
    'no-changes': Number.isFinite(found)
      ? `No changes (${found})`
      : 'No changes',
    error: 'Unavailable',
  };
  button.textContent = labels[state];
}

function resetButtonSoon(delay = 1200) {
  resetTimer = setTimeout(() => setButtonState('idle'), delay);
}

function getActiveTab() {
  return new Promise((resolve) => {
    api.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0] || null);
    });
  });
}

async function sendToActiveTab(message) {
  const tab = await getActiveTab();
  if (!tab) throw new Error('No active tab found');
  return api.tabs.sendMessage(tab.id, message);
}

function showConversionResult(result) {
  if (result?.status === 'no-matches') {
    setButtonState('no-matches', result);
  } else if (result?.status === 'no-changes') {
    setButtonState('no-changes', result);
  } else if (result?.status === 'partial') {
    setButtonState('partial', result);
  } else if (result?.status === 'cancelled' || result?.status === 'stopped') {
    setButtonState('stopped', result);
  } else if (result?.status === 'error') {
    setButtonState('error', result);
  } else {
    setButtonState('complete', result);
  }
}

async function refreshStatus() {
  try {
    const result = await sendToActiveTab({ action: 'status' });
    if (result?.isConverting) {
      setButtonState('converting');
      setTimeout(refreshStatus, 500);
    } else if (result?.lastResult) {
      showConversionResult(result.lastResult);
      resetButtonSoon();
    } else {
      setButtonState('idle');
    }
  } catch (_err) {
    // A newly reloaded extension has no receiver until the Notion tab itself
    // is refreshed. Keep the initial popup quiet; report errors on click.
    setButtonState('idle');
  }
}

button.addEventListener('click', async () => {
  setButtonState('converting');

  try {
    const result = await sendToActiveTab({ action: 'convert' });
    if (result?.status === 'already-running') {
      setButtonState('converting');
      setTimeout(refreshStatus, 500);
      return;
    }
    showConversionResult(result);
    resetButtonSoon();
  } catch (err) {
    console.error("Failed to send message to content script:", err.message);
    setButtonState('error');
    resetButtonSoon(1800);
  }
});

refreshStatus();
