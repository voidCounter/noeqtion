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

// Main Conversion Flow

async function convertMathEquations() {
  // Hide the math dialog box and text action menu to reduce visual distraction during conversion.
  injectCSS(
    'div[role="dialog"] { opacity: 0 !important; transform: scale(0.001) !important; } ' +
      ".notion-text-action-menu { opacity: 0 !important; transform: scale(0.001) !important; pointer-events: none !important; }"
  );

  while (true) {
    const equations = findEquations();

    if (equations.length === 0) {
      break;
    }

    const node = equations[0];
    const match = node.nodeValue.match(EQUATION_REGEX);

    if (match && match[0]) {
      const equationText = match[0];
      await convertSingleEquation(node, equationText);
    } else {
      console.warn("No equation match found in node, skipping");
      break;
    }
  }

  // Remove the injected style
  const styleTag = document.getElementById("notion-math-converter-hide-dialog");
  if (styleTag) {
    styleTag.remove();
  }
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

// Helper Functions

function findEquations() {
  const textNodes = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeValue && EQUATION_REGEX.test(node.nodeValue)) {
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
