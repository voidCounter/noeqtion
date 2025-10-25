console.log("Notion Math Converter content script loaded.");

const EQUATION_REGEX = /(\$\$.*?\$\$|\$.*?\$)/;
const TIMING = {
  // Wait after focusing an editable block so Notion registers the focus (milliseconds)
  FOCUS: 50,
  // Short pause for quick UI updates between small operations (select/delete/insertText)
  QUICK: 20,
  // Wait for dialogs/inputs to appear (Display Block only)
  DIALOG: 100,
  // Extra time for the math block to fully initialize (Display Block only)
  MATH_BLOCK: 150,
  // Wait after a conversion for Notion to update the DOM before rescanning/continuing
  POST_CONVERT: 200,
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
  // Hide the math dialog box to reduce visual distraction during block conversion.
  injectCSS(
    'div[role="dialog"] { opacity: 0 !important; transform: scale(0.001) !important; }'
  );

  const initialCount = findEquations().length;
  let processedCount = 0;

  while (processedCount < initialCount) {
    const equations = findEquations();

    if (equations.length === 0) {
      break;
    }

    const node = equations[0];
    const match = node.nodeValue.match(EQUATION_REGEX);

    if (match && match[0]) {
      const equationText = match[0];
      await convertSingleEquation(node, equationText);
      processedCount++;
    } else {
      console.warn("No equation match found in node, skipping");
      break;
    }
  }

  // CLEANUP CSS: Remove the injected style after all conversions are complete.
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
      ? equationText.slice(2, -2)
      : equationText.slice(1, -1);

    if (isDisplayEquation) {
      await convertDisplayEquation(editableParent, latexContent);
    } else {
      await convertInlineEquation(latexContent);
    }

    await delay(TIMING.POST_CONVERT);
  } catch (err) {
    console.error("Equation conversion failed:", err);
  }
}

async function convertDisplayEquation(editableParent, latexContent) {
  const selection = window.getSelection();
  const blockRange = document.createRange();
  blockRange.selectNodeContents(editableParent);
  selection.removeAllRanges();
  selection.addRange(blockRange);

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
  clickDoneButton();
}

async function convertInlineEquation(latexContent) {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    console.warn("No text selected for inline equation");
    return;
  }

  selection.deleteFromDocument();
  await delay(TIMING.QUICK);

  const fullEquationText = `$$${latexContent}$$`;
  document.execCommand("insertText", false, fullEquationText);

  await delay(TIMING.QUICK);
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
      const globalRegex = /(\$\$.*?\$\$|\$.*?\$)/g;
      const matches = node.nodeValue.match(globalRegex);
      if (matches) {
        for (let i = 0; i < matches.length; i++) {
          textNodes.push(node);
        }
      }
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
