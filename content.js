console.log("Notion Math Converter content script loaded.");

const EQUATION_REGEX = /(\$\$[\s\S]*?\$\$|\$[^\$\n]*?\$)/;
const TIMING = {
  // Wait after focusing an editable block so Notion registers the focus (milliseconds)
  FOCUS: 50,
  // Short pause for quick UI updates between small operations (select/delete/insertText)
  QUICK: 20,
  // Wait for dialogs/inputs to appear (Display Block only)
  DIALOG: 100,
  // Extra time for the math block to fully initialize (Display Block only)
  MATH_BLOCK: 100,
  // Wait after a conversion for Notion to update the DOM before rescanning/continuing
  POST_CONVERT: 300,
  // Fallback timeout for MutationObserver waiting for toggle content to render
  TOGGLE_RENDER_TIMEOUT: 5000,
};

const api = typeof browser !== "undefined" ? browser : chrome;

// Event Listeners

api.runtime.onMessage.addListener((message) => {
  if (message.action === "convert") {
    convertMathEquations();
  }
});

document.addEventListener("keydown", (event) => {
  if (
    event.ctrlKey &&
    event.altKey &&
    (event.key === "M" || event.key === "m")
  ) {
    event.preventDefault();
    convertMathEquations();
  }
});

// Re-entrance guard — prevents concurrent conversions from double-triggering
let isConverting = false;

// Main Conversion Flow

async function convertMathEquations() {
  if (isConverting) return;
  isConverting = true;

  window.focus();
  await delay(50);

  injectCSS(
    'div[role="dialog"] { opacity: 0 !important; transform: scale(0.001) !important; } ' +
      ".notion-text-action-menu { opacity: 0 !important; transform: scale(0.001) !important; pointer-events: none !important; }"
  );

  try {
    await scanAndConvert(document.body);
  } finally {
    removeStyleTag();
    isConverting = false;
  }
}

// Unified DOM-order scan: processes equations and folded toggles in the order
// they appear on the page, recursing into toggle content when encountered.

function findNextItem(root) {
  const equations = findEquations(root);
  const toggles = findFoldedToggles(root).filter(
    (t) => !t.hasAttribute("data-nmq-processed")
  );

  const candidates = [];

  for (const eq of equations) {
    const rect = eq.parentElement?.getBoundingClientRect();
    if (!rect) continue;
    const match = eq.nodeValue.match(EQUATION_REGEX);
    if (!match) continue;
    candidates.push({
      type: "equation",
      node: eq,
      text: match[0],
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
    });
  }

  for (const toggle of toggles) {
    const rect = toggle.getBoundingClientRect();
    candidates.push({
      type: "toggle",
      element: toggle,
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
    });
  }

  candidates.sort((a, b) => a.top - b.top || a.left - b.left);
  return candidates[0] || null;
}

async function scanAndConvert(root) {
  while (true) {
    const next = findNextItem(root);
    if (!next) break;

    if (next.type === "equation") {
      await convertSingleEquation(next.node, next.text);
    } else {
      await processFoldedToggleInPlace(next.element);
    }
  }
}

async function processFoldedToggleInPlace(toggleEl) {
  if (!document.contains(toggleEl)) return;

  try {
    await expandToggle(toggleEl);
  } catch (err) {
    console.warn("Toggle expand failed, skipping:", err);
    return;
  }

  try {
    await scanAndConvert(toggleEl);
  } catch (err) {
    console.error("Equation conversion inside toggle failed:", err);
  }

  collapseToggle(toggleEl);
  toggleEl.setAttribute("data-nmq-processed", "");
}

function removeStyleTag() {
  const styleTag = document.getElementById("notion-math-converter-hide-dialog");
  if (styleTag) styleTag.remove();
}

// Equation Conversion

async function convertSingleEquation(node, equationText) {
  try {
    const startIndex = node.nodeValue.indexOf(equationText);
    if (startIndex === -1) {
      console.warn("Could not find equation text in node:", equationText);
      return;
    }

    const editableParent = findEditableParent(node);
    if (!editableParent) {
      console.warn("Could not find editable parent");
      return;
    }

    editableParent.click();
    await delay(TIMING.FOCUS);

    selectText(node, startIndex, equationText.length);
    await delay(TIMING.QUICK);

    const selection = window.getSelection();
    if (!selection.rangeCount || selection.toString() !== equationText) {
      console.warn("Selection failed or doesn't match equation text");
      return;
    }

    const isDisplayEquation =
      equationText.startsWith("$$") && equationText.endsWith("$$");
    const latexContent = isDisplayEquation
      ? equationText.slice(2, -2).trim()
      : equationText.slice(1, -1);

    if (isDisplayEquation) {
      await convertDisplayEquation(latexContent);
    } else {
      await convertInlineEquation(latexContent);
    }
  } catch (err) {
    console.error("Equation conversion failed:", err);
  }
}

async function convertDisplayEquation(latexContent) {
  const selection = window.getSelection();

  selection.deleteFromDocument();
  await delay(TIMING.FOCUS);

  document.execCommand("insertText", false, "/math");
  await delay(TIMING.DIALOG);

  dispatchKeyEvent("Enter", { keyCode: 13 });
  await delay(TIMING.MATH_BLOCK);

  if (isEditableElement(document.activeElement)) {
    insertTextIntoActiveElement(document.activeElement, latexContent);
  } else {
    console.warn("Could not find math block input");
  }

  await delay(TIMING.DIALOG);

  // Check if there's a KaTeX error in the dialog
  const hasError = document.querySelector('div[role="alert"]') !== null;

  if (hasError) {
    console.warn("KaTeX error detected, closing dialog");
    dispatchKeyEvent("Escape", { keyCode: 27 });
  } else {
    const doneClicked = clickDoneButton();
    if (!doneClicked) {
      dispatchKeyEvent("Escape", { keyCode: 27 });
    }
  }

  await delay(TIMING.POST_CONVERT); // Wait for Notion to process the display equation
}

async function convertInlineEquation(latexContent) {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    console.warn("No text selected for inline equation");
    return;
  }

  // Don't delete first - directly replace the selection with the new text
  const fullEquationText = `$$${latexContent}$$`;
  document.execCommand("insertText", false, fullEquationText);

  await delay(TIMING.POST_CONVERT); // Wait for Notion to process the inline equation
}

function insertTextIntoActiveElement(element, text) {
  if (element.value !== undefined) {
    element.value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    document.execCommand("insertText", false, text);
  }
}

// injects a style rule into the page's <head>.
function injectCSS(css) {
  const style = document.createElement("style");
  style.type = "text/css";
  style.id = "notion-math-converter-hide-dialog";
  style.appendChild(document.createTextNode(css));
  document.head.appendChild(style);
}

// Toggle List Utilities

function findFoldedToggles(root) {
  const toggles = root.querySelectorAll(".notion-toggle-block");
  return Array.from(toggles).filter((toggle) => {
    const button = toggle.querySelector('div[role="button"]');
    return button && button.getAttribute("aria-expanded") === "false";
  });
}

function waitForContentRender(toggleEl, timeout) {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.matches(".notion-selectable") || node.querySelector(".notion-selectable")) {
            observer.disconnect();
            clearTimeout(fallbackTimer);
            resolve();
            return;
          }
        }
      }
    });

    observer.observe(toggleEl, { childList: true, subtree: true });

    const fallbackTimer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timeout waiting for toggle content to render"));
    }, timeout);

    // Check if content is already rendered (toggle was already open)
    if (toggleEl.querySelector(".notion-selectable")) {
      observer.disconnect();
      clearTimeout(fallbackTimer);
      resolve();
    }
  });
}

async function expandToggle(toggleEl) {
  const button = toggleEl.querySelector('div[role="button"]');
  if (!button) throw new Error("Toggle button not found");

  if (button.getAttribute("aria-expanded") === "true") return;

  button.click();
  await waitForContentRender(toggleEl, TIMING.TOGGLE_RENDER_TIMEOUT);
}

function collapseToggle(toggleEl) {
  const button = toggleEl.querySelector('div[role="button"]');
  if (!button) return;

  if (button.getAttribute("aria-expanded") === "false") return;

  button.click();
}

function findContentContainer(toggleEl) {
  const button = toggleEl.querySelector('div[role="button"]');
  if (!button) return null;

  const controlsId = button.getAttribute("aria-controls");
  if (controlsId) {
    const container = toggleEl.querySelector(`#${CSS.escape(controlsId)}`);
    if (container) return container;
  }

  // Fallback: use the toggle element itself as the scan root
  return toggleEl;
}

// Toggle Conversion — handled inline by processFoldedToggleInPlace and scanAndConvert above

// Helper Functions

function findEquations(root) {
  if (root === undefined) root = document.body;
  const textNodes = [];
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && EQUATION_REGEX.test(node.nodeValue)) {
      if (node.parentElement?.closest(".notion-code-block")) continue;
      textNodes.push(node);
    }
  }

  return textNodes;
}

function findEditableParent(node) {
  let parent = node.parentElement;
  while (
    parent &&
    parent.getAttribute("data-content-editable-leaf") !== "true"
  ) {
    parent = parent.parentElement;
  }
  if (parent?.closest(".notion-code-block")) return null;
  return parent;
}

function selectText(node, startIndex, length) {
  const range = document.createRange();
  range.setStart(node, startIndex);
  range.setEnd(node, startIndex + length);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickDoneButton() {
  const doneButton = Array.from(
    document.querySelectorAll('[role="button"]')
  ).find((btn) => btn.textContent.includes("Done"));

  if (doneButton) {
    doneButton.click();
    return true;
  }
  return false;
}

function isEditableElement(element) {
  return (
    element &&
    (element.isContentEditable ||
      element.tagName === "INPUT" ||
      element.tagName === "TEXTAREA")
  );
}

function dispatchKeyEvent(key, options = {}) {
  const activeElement = document.activeElement;
  if (!activeElement) return;

  activeElement.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: key,
      code: options.code || `Key${key.toUpperCase()}`,
      keyCode: options.keyCode || 0,
      which: options.keyCode || 0,
      ctrlKey: options.ctrlKey || false,
      shiftKey: options.shiftKey || false,
      bubbles: true,
      cancelable: true,
    })
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
