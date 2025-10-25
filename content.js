console.log("Notion Math Converter content script loaded.");

const EQUATION_REGEX = /(\$\$.*?\$\$|\$.*?\$)/;
const TIMING = {
  // Wait after focusing an editable block so Notion registers the focus (milliseconds)
  FOCUS: 100,
  // Short pause for quick UI updates between small operations (select/delete/insertText)
  QUICK: 50,
  // Wait for dialogs/inputs to appear (e.g., math dialog) before typing into them
  DIALOG: 200,
  // Extra time for the math block to fully initialize after creating it with "/math" + Enter
  MATH_BLOCK: 300,
  // Wait after a conversion for Notion to update the DOM before rescanning/continuing
  POST_CONVERT: 500,
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
  const initialCount = findEquations().length;
  let processedCount = 0;

  // Process equations one at a time and re-scan after each
  // because DOM changes after each conversion
  while (processedCount < initialCount) {
    const equations = findEquations();

    if (equations.length === 0) {
      break;
    }

    const node = equations[0];

    // Find the FIRST equation in this text node
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
}

// Equation Conversion

async function convertSingleEquation(node, equationText) {
  try {
    const startIndex = node.nodeValue.indexOf(equationText);
    if (startIndex === -1) {
      console.warn("Could not find equation text in node:", equationText);
      return;
    }

    // Focus the Notion editable block
    const editableParent = findEditableParent(node);
    if (!editableParent) {
      console.warn("Could not find editable parent");
      return;
    }

    editableParent.click();
    await delay(TIMING.FOCUS);

    // Select the equation text
    selectText(node, startIndex, equationText.length);
    await delay(TIMING.QUICK);

    // Verify selection was successful
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.toString() !== equationText) {
      console.warn("Selection failed or doesn't match equation text");
      return;
    }

    // Extract LaTeX and determine equation type
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
  // Delete entire line and use /math command
  const selection = window.getSelection();
  const blockRange = document.createRange();
  blockRange.selectNodeContents(editableParent);
  selection.removeAllRanges();
  selection.addRange(blockRange);

  document.execCommand("delete");
  await delay(TIMING.FOCUS);

  document.execCommand("insertText", false, "/math");
  await delay(TIMING.DIALOG);

  dispatchKeyEvent("Enter", { keyCode: 13 });
  await delay(TIMING.MATH_BLOCK);

  // Insert LaTeX into math block dialog
  if (isEditableElement(document.activeElement)) {
    document.execCommand("insertText", false, latexContent);
  } else {
    console.warn("Could not find math block input");
  }

  await delay(TIMING.DIALOG);
  clickDoneButton();
}

async function convertInlineEquation(latexContent) {
  // Verify selection exists before deleting
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    console.warn("No text selected for inline equation");
    return;
  }

  // Delete selected text
  document.execCommand("delete");
  await delay(TIMING.QUICK);

  // Trigger inline equation with Ctrl+Shift+E
  dispatchKeyEvent("e", {
    keyCode: 69,
    ctrlKey: true,
    shiftKey: true,
  });
  await delay(TIMING.DIALOG);

  // Insert LaTeX into inline equation dialog
  const activeElement = document.activeElement;
  if (isEditableElement(activeElement)) {
    // Clear any existing content first
    if (activeElement.value !== undefined) {
      activeElement.value = "";
    }
    document.execCommand("insertText", false, latexContent);
  } else {
    console.warn("No suitable input element focused for inline equation");
  }

  await delay(TIMING.DIALOG);
  clickDoneButton() || dispatchKeyEvent("Enter", { keyCode: 13 });
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
        // Add the node once for each equation found
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
  document.activeElement.dispatchEvent(
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
