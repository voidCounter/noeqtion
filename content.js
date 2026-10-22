console.log("Notion Math Converter content script loaded.");

const EQUATION_REGEX = /(\\\[[\s\S]+?\\\]|\\\([^\n]+?\\\)|\$\$[\s\S]+?\$\$|\$[^\$\n]+?\$)/;
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
  // Yield after each item so a large page cannot monopolize the UI thread
  SCAN_YIELD: 25,
};

const api = typeof browser !== "undefined" ? browser : chrome;

// Event Listeners

api.runtime.onMessage.addListener((message) => {
  if (message.action === "convert") {
    return convertMathEquations();
  }
  if (message.action === "status") {
    return Promise.resolve({ isConverting, lastResult: lastConversionResult });
  }
});

document.addEventListener("keydown", (event) => {
  if (event.isTrusted && isConverting && event.key === "Escape") {
    cancelRequested = true;
    console.warn("Equation conversion cancellation requested");
    return;
  }

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
let cancelRequested = false;
let lastConversionResult = null;

// Main Conversion Flow

async function convertMathEquations() {
  if (isConverting) return { status: "already-running" };
  isConverting = true;
  cancelRequested = false;
  lastConversionResult = null;
  const scanState = createScanState();

  window.focus();
  await delay(50);

  injectCSS(
    'div[role="dialog"] { opacity: 0 !important; transform: scale(0.001) !important; } ' +
      ".notion-text-action-menu { opacity: 0 !important; transform: scale(0.001) !important; pointer-events: none !important; }"
  );

  try {
    await scanAndConvert(document.body, scanState);
    const status = cancelRequested
      ? "cancelled"
      : scanState.equationsFound === 0
        ? "no-matches"
        : scanState.equationsConverted === 0
          ? "no-changes"
          : scanState.equationsConverted < scanState.equationsFound
            ? "partial"
            : "complete";
    lastConversionResult = {
      status,
      equationsFound: scanState.equationsFound,
      equationsConverted: scanState.equationsConverted,
    };
    return lastConversionResult;
  } catch (err) {
    lastConversionResult = {
      status: "error",
      equationsFound: scanState.equationsFound,
      equationsConverted: scanState.equationsConverted,
    };
    throw err;
  } finally {
    removeStyleTag();
    isConverting = false;
  }
}

// Unified DOM-order scan: processes equations and folded toggles in the order
// they appear on the page, recursing into toggle content when encountered.

function findNextItem(root, scanState) {
  while (true) {
    let candidates = scanState.candidateQueues.get(root);
    if (!candidates || candidates.length === 0) {
      candidates = collectCandidates(root, scanState);
      if (candidates.length === 0) return null;
      scanState.candidateQueues.set(root, candidates);
    }

    let detachedCandidateFound = false;
    while (candidates.length > 0) {
      const candidate = candidates.shift();
      if (
        candidate.type === "equation" &&
        scanState.processedEquationKeys.has(candidate.key)
      ) {
        continue;
      }
      if (
        candidate.type === "equation" &&
        (!document.contains(candidate.node) ||
          !document.contains(candidate.range?.endNode || candidate.node))
      ) {
        detachedCandidateFound = true;
        continue;
      }
      if (
        candidate.type === "toggle" &&
        scanState.processedToggleKeys.has(candidate.key)
      ) {
        continue;
      }
      if (
        candidate.type === "toggle" &&
        !document.contains(candidate.element)
      ) {
        detachedCandidateFound = true;
        continue;
      }
      return candidate;
    }

    scanState.candidateQueues.delete(root);
    if (!detachedCandidateFound) return null;
  }
}

function collectCandidates(root, scanState) {
  const equations = findEquations(root);
  const toggles = findFoldedToggles(root);

  const candidates = [];

  for (const eq of equations) {
    const rect = eq.editableParent.getBoundingClientRect();
    if (!rect) continue;
    const key = getEquationKey(eq, rect);
    if (scanState.processedEquationKeys.has(key)) continue;
    candidates.push({
      type: "equation",
      node: eq.startNode,
      range: eq,
      text: eq.text,
      key,
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
    });
  }

  for (const toggle of toggles) {
    const rect = toggle.getBoundingClientRect();
    const key = getToggleKey(toggle, rect);
    if (scanState.processedToggleKeys.has(key)) continue;
    candidates.push({
      type: "toggle",
      element: toggle,
      key,
      top: rect.top + window.scrollY,
      left: rect.left + window.scrollX,
    });
  }

  candidates.sort((a, b) => a.top - b.top || a.left - b.left);
  return candidates;
}

function createScanState() {
  return {
    processedEquationKeys: new Set(),
    processedToggleKeys: new Set(),
    // A full TreeWalker pass is expensive on large Notion pages. Keep the
    // remaining candidates for each live root and only rescan after the batch
    // has been consumed or Notion replaces that root.
    candidateQueues: new WeakMap(),
    equationsFound: 0,
    equationsConverted: 0,
  };
}

async function scanAndConvert(
  root,
  scanState = createScanState(),
  resolveRoot = null
) {
  // A failed conversion must not be selected again by the next rescan. Notion
  // can contain matching text outside editable leaves, and its React renders
  // can also invalidate a selection between discovery and conversion.
  while (true) {
    if (cancelRequested) {
      console.warn("Equation conversion cancelled by user");
      break;
    }

    if (root !== document.body && !document.contains(root)) {
      const replacementRoot = resolveRoot?.();
      if (!replacementRoot || !document.contains(replacementRoot)) break;
      root = replacementRoot;
    }

    const next = findNextItem(root, scanState);
    if (!next) break;

    if (next.type === "equation") {
      scanState.equationsFound += 1;
      // Record the content signature before editing. React can replace the
      // text node even when the underlying equation did not change.
      scanState.processedEquationKeys.add(next.key);
      const converted = await convertSingleEquation(
        next.node,
        next.text,
        next.range
      );
      if (converted) scanState.equationsConverted += 1;
    } else {
      // Mark the stable toggle key before clicking. Notion may replace the DOM
      // element while expanding or collapsing it, invalidating element-based
      // markers and WeakSet membership.
      scanState.processedToggleKeys.add(next.key);
      await processFoldedToggleInPlace(next.element, scanState);
    }

    await delay(TIMING.SCAN_YIELD);
  }
}

async function processFoldedToggleInPlace(toggleEl, scanState) {
  if (!document.contains(toggleEl)) return true;
  const toggleKey = getToggleKey(toggleEl);
  let expandedToggle = toggleEl;

  try {
    expandedToggle = await expandToggle(toggleEl, toggleKey);
  } catch (err) {
    console.warn("Toggle expand failed, skipping:", err);
    collapseToggle(findToggleByKey(toggleKey) || toggleEl);
    return false;
  }

  try {
    await scanAndConvert(
      expandedToggle,
      scanState,
      () => findToggleByKey(toggleKey)
    );
  } catch (err) {
    console.error("Equation conversion inside toggle failed:", err);
  } finally {
    collapseToggle(findToggleByKey(toggleKey) || expandedToggle);
  }
  return true;
}

function removeStyleTag() {
  const styleTag = document.getElementById("notion-math-converter-hide-dialog");
  if (styleTag) styleTag.remove();
}

// Equation Conversion

function parseEquation(equationText) {
  const isBracketDisplayEquation =
    equationText.startsWith("\\[") && equationText.endsWith("\\]");
  const isDollarDisplayEquation =
    equationText.startsWith("$$") && equationText.endsWith("$$");
  const isParenInlineEquation =
    equationText.startsWith("\\(") && equationText.endsWith("\\)");
  const isDisplayEquation =
    isBracketDisplayEquation || isDollarDisplayEquation;
  let latexContent = isDisplayEquation
    ? equationText.slice(2, -2).trim()
    : isParenInlineEquation
      ? equationText.slice(2, -2)
      : equationText.slice(1, -1);

  // GitHub-flavored Markdown writes inline math as $`...`$. The backticks
  // delimit the code span and are not part of the LaTeX passed to Notion.
  if (
    !isDisplayEquation &&
    !isParenInlineEquation &&
    latexContent.startsWith("`") &&
    latexContent.endsWith("`")
  ) {
    latexContent = latexContent.slice(1, -1);
  }

  return { isDisplayEquation, latexContent };
}

async function convertSingleEquation(node, equationText, equationRange = null) {
  try {
    if (!document.contains(node)) {
      console.warn("Equation node is no longer attached, skipping");
      return false;
    }

    const editableParent =
      equationRange?.editableParent || findEditableParent(node);
    if (!editableParent) {
      console.warn("Could not find editable parent");
      return false;
    }
    const originalEditableText = editableParent.textContent;

    editableParent.click();
    await delay(TIMING.FOCUS);

    if (equationRange) {
      selectTextRange(equationRange);
    } else {
      const startIndex = node.nodeValue.indexOf(equationText);
      if (startIndex === -1) {
        console.warn("Could not find equation text in node:", equationText);
        return false;
      }
      selectText(node, startIndex, equationText.length);
    }
    await delay(TIMING.QUICK);

    const selection = window.getSelection();
    if (!selection.rangeCount || selection.toString() !== equationText) {
      console.warn("Selection failed or doesn't match equation text");
      return false;
    }

    const { isDisplayEquation, latexContent } = parseEquation(equationText);
    if (!latexContent.trim()) {
      console.warn("Empty equation, skipping");
      return false;
    }

    let converted;
    if (isDisplayEquation) {
      converted = await convertDisplayEquation(
        latexContent,
        editableParent,
        equationText
      );
    } else {
      converted = await convertInlineEquation(latexContent);
    }
    if (!converted) return false;

    if (
      document.contains(editableParent) &&
      editableParent.textContent === originalEditableText
    ) {
      console.warn(
        "Equation conversion made no progress, skipping:",
        equationText
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error("Equation conversion failed:", err);
    return false;
  }
}

async function convertDisplayEquation(
  latexContent,
  originalEditableParent,
  originalEquationText
) {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) return false;

  selection.deleteFromDocument();
  await delay(TIMING.FOCUS);

  document.execCommand("insertText", false, "/math");
  await delay(TIMING.DIALOG);

  dispatchKeyEvent("Enter", { keyCode: 13 });
  await delay(TIMING.MATH_BLOCK);

  const mathInput = document.activeElement;
  if (
    !isEditableElement(mathInput) ||
    mathInput === originalEditableParent
  ) {
    console.warn("Could not find math block input");
    await rollbackDisplayConversion(originalEquationText);
    return false;
  }
  if (!insertTextIntoActiveElement(mathInput, latexContent)) {
    console.warn("Could not insert LaTeX into the math block input");
    await rollbackDisplayConversion(originalEquationText);
    return false;
  }

  await delay(TIMING.DIALOG);

  // Check if there's a KaTeX error in the dialog
  const dialog = mathInput.closest?.('[role="dialog"]');
  const hasError =
    (dialog || document).querySelector('div[role="alert"]') !== null;

  if (hasError) {
    console.warn("KaTeX error detected, closing dialog");
    await rollbackDisplayConversion(originalEquationText);
    return false;
  } else {
    let doneClicked = clickDoneButton(dialog || document);
    if (!doneClicked && dialog) doneClicked = clickDoneButton(document);
    if (!doneClicked) {
      dispatchKeyEvent("Escape", { keyCode: 27 });
    }
  }

  await delay(TIMING.POST_CONVERT); // Wait for Notion to process the display equation
  return true;
}

async function convertInlineEquation(latexContent) {
  const selection = window.getSelection();
  if (!selection.rangeCount || selection.isCollapsed) {
    console.warn("No text selected for inline equation");
    return false;
  }

  // Don't delete first - directly replace the selection with the new text
  const fullEquationText = `$$${latexContent}$$`;
  const inserted = document.execCommand("insertText", false, fullEquationText);

  await delay(TIMING.POST_CONVERT); // Wait for Notion to process the inline equation
  return inserted !== false;
}

async function rollbackDisplayConversion(originalEquationText) {
  dispatchKeyEvent("Escape", { keyCode: 27 });
  await delay(TIMING.QUICK);
  const restored = document.execCommand("undo");
  if (!restored) {
    console.error(
      "Could not automatically restore the original equation:",
      originalEquationText
    );
  }
  await delay(TIMING.POST_CONVERT);
}

function insertTextIntoActiveElement(element, text) {
  if (element.value !== undefined) {
    element.value = text;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    return element.value === text;
  } else {
    return document.execCommand("insertText", false, text) !== false;
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

function getToggleKey(toggleEl, rect = toggleEl.getBoundingClientRect()) {
  const blockId = toggleEl.getAttribute("data-block-id");
  if (blockId) return `block:${blockId}`;

  const button = toggleEl.querySelector('div[role="button"]');
  const controlsId = button?.getAttribute("aria-controls");
  if (controlsId) return `controls:${controlsId}`;

  // Last-resort identity for DOM variants without Notion IDs. Position plus
  // title survives the element replacement caused by collapsing a toggle.
  const top = Math.round(rect.top + window.scrollY);
  const left = Math.round(rect.left + window.scrollX);
  const title = button?.textContent?.trim() || "";
  return `position:${top}:${left}:${title}`;
}

function findToggleByKey(key, root = document) {
  const toggles = root.querySelectorAll(".notion-toggle-block");
  return Array.from(toggles).find((toggle) => getToggleKey(toggle) === key) || null;
}

function getEquationKey(equation, rect) {
  const editableParent = equation.editableParent;
  const blockId = editableParent
    ?.closest("[data-block-id]")
    ?.getAttribute("data-block-id");
  const contentKey = `${editableParent.textContent}:${equation.startIndex}:${equation.text}`;
  if (blockId) return `block:${blockId}:${contentKey}`;

  const top = Math.round(rect.top + window.scrollY);
  const left = Math.round(rect.left + window.scrollX);
  return `position:${top}:${left}:${contentKey}`;
}

function findFoldedToggles(root) {
  const toggles = root.querySelectorAll(".notion-toggle-block");
  return Array.from(toggles).filter((toggle) => {
    const button = toggle.querySelector('div[role="button"]');
    return button && button.getAttribute("aria-expanded") === "false";
  });
}

function waitForContentRender(toggleEl, toggleKey, timeout) {
  return new Promise((resolve, reject) => {
    const resolveRenderedToggle = () => {
      const currentToggle = findToggleByKey(toggleKey) ||
        (document.contains(toggleEl) ? toggleEl : null);
      const button = currentToggle?.querySelector('div[role="button"]');
      const controlsId = button?.getAttribute("aria-controls");
      const controlledContent = controlsId
        ? document.getElementById(controlsId)
        : null;
      if (
        currentToggle &&
        button?.getAttribute("aria-expanded") === "true" &&
        (currentToggle.querySelector(".notion-selectable") || controlledContent)
      ) {
        observer.disconnect();
        clearTimeout(fallbackTimer);
        resolve(currentToggle);
        return true;
      }
      return false;
    };

    const observer = new MutationObserver(resolveRenderedToggle);

    observer.observe(document.body, { childList: true, subtree: true });

    const fallbackTimer = setTimeout(() => {
      observer.disconnect();
      reject(new Error("Timeout waiting for toggle content to render"));
    }, timeout);

    resolveRenderedToggle();
  });
}

async function expandToggle(toggleEl, toggleKey = getToggleKey(toggleEl)) {
  const button = toggleEl.querySelector('div[role="button"]');
  if (!button) throw new Error("Toggle button not found");

  if (button.getAttribute("aria-expanded") === "true") return toggleEl;

  button.click();
  return waitForContentRender(
    toggleEl,
    toggleKey,
    TIMING.TOGGLE_RENDER_TIMEOUT
  );
}

function collapseToggle(toggleEl) {
  const button = toggleEl.querySelector('div[role="button"]');
  if (!button) return;

  if (button.getAttribute("aria-expanded") === "false") return;

  button.click();
}

// Toggle Conversion — handled inline by processFoldedToggleInPlace and scanAndConvert above

// Helper Functions

function findEquations(root) {
  if (root === undefined) root = document.body;
  const nodesByEditableParent = new Map();
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );

  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue) continue;
    if (node.parentElement?.closest(".notion-code-block")) continue;
    const editableParent = findEditableParent(node);
    if (!editableParent) continue;
    if (!nodesByEditableParent.has(editableParent)) {
      nodesByEditableParent.set(editableParent, []);
    }
    nodesByEditableParent.get(editableParent).push(node);
  }

  return Array.from(nodesByEditableParent, ([editableParent, textNodes]) =>
    findEquationsInTextNodes(textNodes, editableParent)
  ).flat();
}

function findEquationsInTextNodes(textNodes, editableParent) {
  const combinedText = textNodes.map((node) => node.nodeValue).join("");
  const regex = new RegExp(EQUATION_REGEX.source, "g");
  const equations = [];
  let match;

  while ((match = regex.exec(combinedText))) {
    const start = locateTextOffset(textNodes, match.index, false);
    const end = locateTextOffset(
      textNodes,
      match.index + match[0].length,
      true
    );
    if (!start || !end) continue;
    equations.push({
      editableParent,
      startNode: start.node,
      startOffset: start.offset,
      endNode: end.node,
      endOffset: end.offset,
      startIndex: match.index,
      text: match[0],
    });
  }

  return equations;
}

function locateTextOffset(textNodes, absoluteOffset, preferPreviousNode) {
  let consumed = 0;
  for (let index = 0; index < textNodes.length; index += 1) {
    const node = textNodes[index];
    const next = consumed + node.nodeValue.length;
    const atBoundary = absoluteOffset === next;
    if (
      absoluteOffset < next ||
      (atBoundary && (preferPreviousNode || index === textNodes.length - 1))
    ) {
      return { node, offset: absoluteOffset - consumed };
    }
    consumed = next;
  }
  return null;
}

function findEditableParent(node) {
  let parent = node.parentElement;
  let inheritedEditable = null;

  while (parent) {
    const contentEditable = parent.getAttribute("contenteditable");
    if (
      parent.getAttribute("data-content-editable-leaf") === "true" ||
      contentEditable === "true" ||
      contentEditable === "plaintext-only"
    ) {
      break;
    }
    if (!inheritedEditable && parent.isContentEditable) {
      inheritedEditable = parent;
    }
    parent = parent.parentElement;
  }

  parent = parent || inheritedEditable;
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

function selectTextRange(equationRange) {
  const range = document.createRange();
  range.setStart(equationRange.startNode, equationRange.startOffset);
  range.setEnd(equationRange.endNode, equationRange.endOffset);

  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickDoneButton(root = document) {
  const doneButton = Array.from(
    root.querySelectorAll('[role="button"]')
  ).find((btn) => /Done|완료/i.test(btn.textContent));

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
