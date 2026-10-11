const { LinterPanel } = require("../lib/linter-panel");
const { Front } = require("../lib/front");
const { normalize, fakeHub } = require("./fake-hub");

// The panel header, the severity filter and the severity sort are all driven by
// the severity vocabulary the hub hands over. These specs pin the
// generalization, and the two ways an unknown severity used to break the panel:
// a blank cell and a NaN sort.
describe("lib/linter-panel", () => {
  let panel;
  let front;
  let messages;
  let cursorEditor;

  const message = (severity, row = 0) => ({
    severity,
    excerpt: `${severity} at ${row}`,
    linterName: "spec",
    location: {
      file: "/a.js",
      position: [
        [row, 0],
        [row, 1],
      ],
    },
  });

  const rowsInOrder = () =>
    Array.from(panel.element.querySelectorAll(".linter-row")).map(
      (row) => row.querySelector(".linter-severity")?.textContent,
    );

  // The real front end against a stand-in hub: the seam under test is the panel
  // against the front end, and the front end is thin enough that stubbing it
  // would only pin a fiction.
  beforeEach(async () => {
    lumine.config.set("linter-panel.defaultSortMethod", "severity");
    messages = [];
    cursorEditor = null;
    front = new Front();
    front.attach(fakeHub({ messages: () => messages, editor: () => cursorEditor }));
    panel = new LinterPanel(front);
    front.panel = panel;
    jasmine.attachToDOM(panel.element);
    await panel.update();
  });

  afterEach(async () => {
    await panel.destroy?.();
    front.dispose();
  });

  const publish = async (severities) => {
    messages = normalize(severities.map((severity, index) => message(severity, index)));
    front.render({ messages });
    await panel.update();
  };

  it("keeps the panel in the bottom dock", () => {
    expect(panel.getDefaultLocation()).toBe("bottom");
    expect(panel.getAllowedLocations()).toEqual(["bottom"]);
  });

  describe("the keyboard cursor", () => {
    const focusedRows = () => panel.element.querySelectorAll(".linter-row.focused").length;
    const focusedText = () =>
      panel.element.querySelector(".linter-row.focused .linter-excerpt")?.textContent.trim();

    it("does not exist until the first arrow press, entering from the ends", async () => {
      await publish(["error", "warning", "info"]);
      expect(focusedRows()).toBe(0);

      panel._moveFocus(-1);
      await panel.update();
      expect(focusedText()).toBe("info at 2");

      panel._setFocusedMessage(null);
      panel._moveFocus(1);
      await panel.update();
      expect(focusedText()).toBe("error at 0");
    });

    it("tracks the message itself through a refresh, and dies with it", async () => {
      await publish(["error", "warning", "info"]);
      panel._moveFocus(1);
      await panel.update();
      const focused = panel._focusedMessage;
      expect(focused.excerpt).toBe("error at 0");

      // A refresh that keeps the message keeps the cursor on it.
      messages = [messages[1], messages[0]];
      await panel.update();
      expect(panel._focusedMessage).toBe(focused);
      expect(focusedText()).toBe("error at 0");

      // One that drops the message drops the cursor's row with it.
      messages = messages.filter((candidate) => candidate !== focused);
      await panel.update();
      expect(focusedRows()).toBe(0);
    });

    it("confirm needs a cursor, reveals the message, and drops the cursor", async () => {
      const revealed = [];
      front.revealMessage = (message) => revealed.push(message.excerpt);
      await publish(["error", "warning"]);

      panel._confirmFocused();
      expect(revealed).toEqual([]);

      panel._moveFocus(1);
      panel._confirmFocused();
      await panel.update();
      expect(revealed).toEqual(["error at 0"]);
      expect(focusedRows()).toBe(0);
    });

    it("leaving the panel drops the cursor", async () => {
      await publish(["error", "warning"]);
      panel._moveFocus(1);
      await panel.update();
      expect(focusedRows()).toBe(1);

      panel.element.dispatchEvent(new FocusEvent("focusout", { relatedTarget: null }));
      await panel.update();
      expect(focusedRows()).toBe(0);
    });

    it("keeps focus on the latest object for an unchanged diagnostic key", async () => {
      await publish(["error", "warning"]);
      panel._setFocusedMessage(messages[0]);
      await panel.update();
      const original = messages[0];
      const replacement = { ...original, description: "latest details" };
      messages = [replacement, messages[1]];
      front.render({ added: [], removed: [], updated: [replacement], messages });
      await panel.update();

      expect(panel._focusedMessage).toBe(replacement);
      expect(focusedText()).toBe(original.excerpt);
      expect(panel.element.querySelector(".linter-row.focused .linter-detail").textContent).toBe(
        "latest details",
      );
      const reveal = spyOn(front, "revealMessage");
      panel._confirmFocused();
      expect(reveal).toHaveBeenCalledOnceWith(replacement);
    });

    it("drops keyboard focus when its message is filtered out", async () => {
      await publish(["error", "warning"]);
      panel._setFocusedMessage(messages[0]);
      await panel.update();

      panel.toggleVisibility("error");
      await panel.update();

      expect(panel._focusedMessage).toBeNull();
      const reveal = spyOn(front, "revealMessage");
      panel._confirmFocused();
      expect(reveal).not.toHaveBeenCalled();
    });
  });

  describe("the indexed cursor highlight", () => {
    let editor;

    beforeEach(async () => {
      editor = await lumine.workspace.open();
      editor.setText("a\nb\nc\n");
      editor.setCursorBufferPosition([1, 0]);
      cursorEditor = editor;
    });

    afterEach(() => editor.destroy());

    const currentMessage = () => panel._currentMessage();

    it("does not read other diagnostic ranges during a cursor update", async () => {
      messages = normalize(Array.from({ length: 2000 }, (_, row) => message("warning", row)));
      const target = messages[1];
      const query = jasmine.createSpy("getMessagesAtPosition").and.returnValue([target]);
      front.hub.getMessagesAtPosition = query;
      const reads = messages.map((entry) => {
        const read = jasmine.createSpy("displayRange").and.throwError("range scanned");
        Object.defineProperty(entry.location, "displayRange", { get: read });
        return read;
      });
      front.setEditor();
      front.render({ messages });
      await panel.update();
      query.calls.reset();

      panel._updateCurrentRowHighlight();

      expect(query).toHaveBeenCalledOnceWith(editor, editor.getCursorBufferPosition());
      expect(reads.every((read) => read.calls.count() === 0)).toBe(true);
      expect(currentMessage()).toBe(target);
    });

    it("takes the first visible candidate in the selected sort order", async () => {
      messages = normalize([message("warning", 1), message("error", 1)]);
      const [warning, error] = messages;
      front.hub.getMessagesAtPosition = () => [warning, error];
      front.setEditor();
      front.render({ messages });
      await panel.update();
      expect(currentMessage()).toBe(error);

      panel.setSortMethod("severity");
      await panel.update();
      expect(currentMessage()).toBe(warning);

      panel.toggleVisibility("warning");
      await panel.update();
      expect(currentMessage()).toBe(error);
      panel.toggleVisibility("error");
      await panel.update();
      expect(currentMessage()).toBeNull();
    });

    it("highlights only the queried editor's candidate in project mode", async () => {
      const own = message("warning", 1);
      const foreign = message("error", 1);
      foreign.location.file = "/b.js";
      messages = normalize([foreign, own]);
      front.hub.getCurrentMessages = () => [own];
      front.hub.getMessagesAtPosition = () => [own];
      front.setEditor();
      front.render({ messages });
      front.setViewMode("project");
      await panel.update();

      expect(currentMessage()).toBe(own);
      expect(panel._currentRowIndex).toBe(1);
    });

    it("accepts an empty indexed result without falling back to range scans", async () => {
      messages = normalize([message("warning", 1)]);
      front.hub.getMessagesAtPosition = () => [];
      const range = jasmine.createSpy("displayRange").and.throwError("fallback scanned");
      Object.defineProperty(messages[0].location, "displayRange", { get: range });
      front.setEditor();
      front.render({ messages });
      await panel.update();

      expect(currentMessage()).toBeNull();
      expect(range).not.toHaveBeenCalled();
    });

    it("uses the original current-file fallback when the hub has no index", async () => {
      const own = message("warning", 1);
      const foreign = message("error", 1);
      foreign.location.file = "/b.js";
      messages = normalize([foreign, own]);
      front.hub.getCurrentMessages = () => [own];
      front.setEditor();
      front.render({ messages });
      front.setViewMode("project");
      await panel.update();

      expect(currentMessage()).toBe(own);
    });
  });

  describe("the filter header", () => {
    it("renders one checkbox per severity, in precedence order, all checked", () => {
      const labels = Array.from(panel.element.querySelectorAll(".input-label"));
      expect(labels.map((label) => label.className)).toEqual([
        "input-label error",
        "input-label warning",
        "input-label info",
        "input-label hint",
      ]);
      expect(labels.every((label) => label.querySelector("input").checked)).toBe(true);
      expect(labels[3].title).toBe("Toggle Hint messages");
    });

    it("hides only the severity that was toggled off", async () => {
      await publish(["error", "hint", "warning"]);
      expect(rowsInOrder().length).toBe(3);

      panel.toggleVisibility("hint");
      await panel.update();
      expect(rowsInOrder()).toEqual(["Error", "Warning"]);

      panel.toggleVisibility("hint");
      await panel.update();
      expect(rowsInOrder().length).toBe(3);
    });

    it("shows everything by default", () => {
      expect(panel.hiddenSeverities.size).toBe(0);
      expect(panel.isSeverityVisible("hint")).toBe(true);
      expect(panel.isSeverityVisible("boom")).toBe(true);
    });
  });

  describe("the severity sort", () => {
    it("orders error, warning, info, hint", async () => {
      await publish(["hint", "info", "error", "warning"]);
      expect(rowsInOrder()).toEqual(["Error", "Warning", "Info", "Hint"]);
    });

    // The severityOrder literal this replaced produced NaN for an unknown
    // severity, which silently scrambled the whole table.
    it("puts an unknown severity last instead of scrambling the order", async () => {
      await publish(["boom", "hint", "error"]);
      expect(rowsInOrder()).toEqual(["Error", "Hint", "boom"]);
    });
  });

  // The description cell used to render the excerpt and nothing else, so
  // `Message.description` and `Message.url` — where a language server puts its
  // rule code and its documentation link — never reached the panel at all.
  describe("the description cell", () => {
    const publishOne = async (overrides) => {
      messages = normalize([Object.assign(message("error"), overrides)]);
      front.render({ messages });
      await panel.update();
    };

    // Only microtasks separate the click from the re-render, so flushing them
    // and re-rendering is deterministic — no timer, no polling.
    const settle = async () => {
      for (let i = 0; i < 10; i++) await Promise.resolve();
      await panel.update();
    };

    const cell = () => panel.element.querySelector(".linter-description");

    it("renders the excerpt beside a string description", async () => {
      await publishOne({ description: "Ruff: F401" });
      expect(cell().querySelector(".linter-excerpt").textContent.trim()).toBe("error at 0");
      const detail = cell().querySelector(".linter-detail");
      expect(detail.textContent).toBe("Ruff: F401");
      expect(detail.title).toBe("Ruff: F401");
      expect(cell().querySelector(".linter-detail-toggle")).toBeNull();
    });

    it("renders only the excerpt when the message has no long form", async () => {
      await publishOne({});
      expect(cell().querySelector(".linter-excerpt").textContent.trim()).toBe("error at 0");
      expect(cell().querySelector(".linter-detail")).toBeNull();
      expect(cell().querySelector(".linter-detail-toggle")).toBeNull();
      expect(cell().querySelector(".linter-more-info")).toBeNull();
    });

    it("resolves a lazy description when its affordance is clicked", async () => {
      let calls = 0;
      await publishOne({
        description: () => {
          calls++;
          return Promise.resolve("the long form");
        },
      });
      expect(calls).toBe(0);
      expect(cell().querySelector(".linter-detail")).toBeNull();

      cell().querySelector(".linter-detail-toggle").click();
      await settle();

      expect(calls).toBe(1);
      expect(cell().querySelector(".linter-detail").textContent).toBe("the long form");
      expect(cell().querySelector(".linter-detail-toggle")).toBeNull();
    });

    it("opens the message url externally instead of revealing the message", async () => {
      spyOn(lumine.shell, "openExternal").and.resolveTo();
      const reveal = spyOn(front, "revealMessage");
      await publishOne({ url: "https://docs.astral.sh/ruff/rules/unused-import" });

      cell().querySelector(".linter-more-info").click();

      expect(lumine.shell.openExternal).toHaveBeenCalledWith(
        "https://docs.astral.sh/ruff/rules/unused-import",
      );
      expect(reveal).not.toHaveBeenCalled();
    });

    it("does not render an unsupported provider URL", async () => {
      await publishOne({ url: "javascript:alert(1)" });

      expect(cell().querySelector(".linter-more-info")).toBeNull();
    });

    it("reports a failure to open provider documentation", async () => {
      const error = new Error("no browser");
      spyOn(lumine.shell, "openExternal").and.rejectWith(error);
      spyOn(lumine.notifications, "addWarning");
      await publishOne({ url: "https://example.com/rule" });

      cell().querySelector(".linter-more-info").click();
      await conditionPromise(() => lumine.notifications.addWarning.calls.any());

      expect(lumine.notifications.addWarning).toHaveBeenCalledWith(
        "Unable to open the linter documentation.",
        { detail: error.message, dismissable: true },
      );
    });
  });

  it("labels a row of unknown severity with its raw name, not undefined", async () => {
    await publish(["boom"]);
    const row = panel.element.querySelector(".linter-row");
    expect(row.className).toBe("linter-row unknown");
    expect(row.querySelector(".linter-severity").textContent).toBe("boom");
  });

  // The list renders only the rows the viewport can show. Everything outside
  // `render` addresses a row by its index in the visible list, so a row that is
  // not in the DOM still has to be findable, scrollable to and highlightable.
  describe("with more messages than fit on screen", () => {
    const TOTAL = 9300;

    const rows = () => Array.from(panel.element.querySelectorAll(".linter-row"));
    const renderedIndices = () =>
      rows()
        .map((row) => parseInt(row.dataset.visibleIndex, 10))
        .sort((a, b) => a - b);
    const scrollContainer = () => panel.element.querySelector("tbody");

    let stylesheet;

    beforeEach(async () => {
      // These specs build the panel directly rather than activating the package,
      // so its stylesheet is not loaded — and without it the tbody has no
      // definite height, never scrolls, and the window is the whole list. The
      // row height and the scroll container are the subject here, so the real
      // rules have to be in the document.
      stylesheet = lumine.themes.requireStylesheet(require.resolve("../styles/main.css"));
      // The panel is height:100% of whatever holds it, and the spec's wrapper
      // has no height to inherit.
      panel.element.style.height = "300px";
      messages = [];
      for (let i = 0; i < TOTAL; i++) {
        messages.push(message("error", i));
      }
      normalize(messages);
      front.render({ messages });
      await panel.update();
      // The first render measures a row and takes the real window.
      await panel.update();
    });

    afterEach(() => {
      stylesheet.dispose();
    });

    it("renders a small window rather than a row per message", () => {
      expect(rows().length).toBeGreaterThan(0);
      expect(rows().length).toBeLessThan(200);
    });

    it("keeps the scroll height of the whole list", () => {
      const rowHeight = panel._rowHeight;
      expect(rowHeight).toBeGreaterThan(0);
      // scrollHeight rounds to pixels; spacers retain fractional row heights.
      // The header is not part of the scrolling area.
      expect(Math.abs(scrollContainer().scrollHeight - TOTAL * rowHeight)).toBeLessThan(rowHeight);
    });

    it("measures fractional row heights without rounding every spacer", () => {
      panel._rowHeight = 0;
      const row = rows()[0];
      const bounds = row.getBoundingClientRect();
      spyOn(row, "getBoundingClientRect").and.returnValue({ ...bounds, height: 25.375 });

      expect(panel._measureRowHeight()).toBe(25.375);
    });

    it("keeps a render window inside a list that shrinks below its old scroll position", async () => {
      scrollContainer().scrollTop = 8000 * panel._rowHeight;
      await panel.update();
      messages = messages.slice(0, 103);
      front.render({ messages });
      await panel.update();
      await panel.update();

      expect(panel._window.start).toBeLessThan(panel._window.end);
      expect(panel._window.end).toBeLessThanOrEqual(messages.length);
      expect(renderedIndices()).toContain(102);
      expect(scrollContainer().scrollHeight).toBeLessThan((messages.length + 1) * panel._rowHeight);
    });

    it("keeps a fast wheel-sized jump covered until the next render", () => {
      const container = scrollContainer();
      container.scrollTop = 800;
      const bounds = container.getBoundingClientRect();
      const rendered = rows();

      expect(rendered[0].getBoundingClientRect().top).toBeLessThanOrEqual(bounds.top);
      expect(rendered[rendered.length - 1].getBoundingClientRect().bottom).toBeGreaterThanOrEqual(
        bounds.bottom,
      );
    });

    it("keeps every row one line high with long providers and block excerpts", async () => {
      panel.element.style.width = "600px";
      messages = normalize([
        message("warning"),
        {
          ...message("warning", 1),
          linterName: "Basedpyright Language Server",
          excerpt: "first paragraph\n\nsecond paragraph",
        },
      ]);
      front.render({ messages });
      await panel.update();

      const heights = rows().map((row) => row.getBoundingClientRect().height);
      expect(heights[1]).toBe(heights[0]);
      expect(heights[0]).toBeLessThan(35);
    });

    it("renders the rows around wherever it has been scrolled to", async () => {
      const rowHeight = panel._rowHeight;
      scrollContainer().scrollTop = 2000 * rowHeight;
      await panel.update();

      const indices = renderedIndices();
      expect(indices[0]).toBeLessThanOrEqual(2000);
      expect(indices[indices.length - 1]).toBeGreaterThanOrEqual(2000);
      expect(indices.length).toBeLessThan(200);
    });

    it("does not re-render for a scroll that does not change the window", () => {
      const update = spyOn(panel, "update").and.callThrough();
      panel._onScroll();

      expect(update).not.toHaveBeenCalled();
    });

    it("reuses the rendered block for small wheel steps", async () => {
      scrollContainer().scrollTop = 100 * panel._rowHeight;
      await panel.update();
      const update = spyOn(panel, "update").and.callThrough();

      scrollContainer().scrollTop = 104 * panel._rowHeight;
      panel._onScroll();

      expect(update).not.toHaveBeenCalled();
    });

    it("preserves overlapping row nodes and their positions across scroll blocks", async () => {
      const container = scrollContainer();
      const rowAt = (index) =>
        container.querySelector(`.linter-row[data-visible-index="${index}"]`);
      const row = rowAt(40);
      const excerpt = row.querySelector(".linter-excerpt");
      const content = excerpt.firstChild;
      const documentTop = row.getBoundingClientRect().top + container.scrollTop;

      // Crossing this boundary adds a leading spacer and removes the first ten
      // rows. The rows both windows contain must keep their painted contents.
      container.scrollTop = 50 * panel._rowHeight;
      await panel.update();

      expect(rowAt(40)).toBe(row);
      expect(row.querySelector(".linter-excerpt")).toBe(excerpt);
      expect(excerpt.firstChild).toBe(content);
      expect(
        Math.abs(row.getBoundingClientRect().top + container.scrollTop - documentTop),
      ).toBeLessThan(1);

      container.scrollTop = 0;
      await panel.update();

      expect(rowAt(40)).toBe(row);
      expect(excerpt.firstChild).toBe(content);
    });

    it("re-renders for a scroll that does change the window", () => {
      const update = spyOn(panel, "update").and.callThrough();
      scrollContainer().scrollTop = 2000 * panel._rowHeight;
      panel._onScroll();

      expect(update).toHaveBeenCalled();
    });

    it("scrolls a row far down the list into view without measuring it", () => {
      panel._scrollIndexIntoView(4000);

      const expected = 4000 * panel._rowHeight;
      expect(scrollContainer().scrollTop).toBeGreaterThan(expected - panel._rowHeight * 20);
    });

    // The point of the window is that a render costs what the viewport costs,
    // not what the message list costs. Fifty times the messages should not be
    // fifty times the render.
    it("renders in time that does not grow with the length of the list", async () => {
      const time = async (total) => {
        messages = [];
        for (let i = 0; i < total; i++) messages.push(message("error", i));
        normalize(messages);
        front.render({ messages });
        await panel.update();

        let best = Infinity;
        for (let run = 0; run < 4; run++) {
          panel._visibleCache = null;
          const started = performance.now();
          await panel.update();
          best = Math.min(best, performance.now() - started);
        }
        return best;
      };

      const small = await time(100);
      const large = await time(5000);

      // Sorting and filtering are still linear in the list, so this is not flat
      // — but a row per message was multiples of this. Generous slack keeps a
      // loaded runner green while still catching a return to rendering all of it.
      expect(large).toBeLessThan(small * 8 + 100);
    });

    it("highlights the cursor's row once it is inside the window", async () => {
      const editor = await lumine.workspace.open();
      editor.setText("x\n".repeat(TOTAL));
      editor.setCursorBufferPosition([2000, 0]);
      panel.setEditor(editor);
      front.setViewMode("file");
      await panel.update();

      panel._updateCurrentRowHighlight();
      await panel.update();
      panel._updateCurrentRowHighlight();

      const current = panel.element.querySelector(".linter-row.current");
      expect(current).not.toBeNull();
      expect(parseInt(current.dataset.visibleIndex, 10)).toBe(2000);
      editor.destroy();
    });

    it("lets the current row leave the viewport and restores its highlight on return", async () => {
      const editor = await lumine.workspace.open();
      try {
        editor.setText("x\n".repeat(TOTAL));
        editor.setCursorBufferPosition([2000, 0]);
        panel.setEditor(editor);
        await panel.update();
        await panel.update();
        expect(panel._currentMessage()).toBe(messages[2000]);

        for (const row of [4000, 0]) {
          scrollContainer().scrollTop = row * panel._rowHeight;
          const scrollTop = scrollContainer().scrollTop;
          panel._onScroll();
          await panel.update();

          expect(scrollContainer().scrollTop).toBe(scrollTop);
          expect(renderedIndices()).not.toContain(2000);
          expect(panel._currentRowIndex).toBe(2000);
          expect(panel._currentMessage()).toBe(messages[2000]);
          expect(panel.element.querySelector(".linter-row.current")).toBeNull();
        }

        scrollContainer().scrollTop = 2000 * panel._rowHeight;
        panel._onScroll();
        await panel.update();

        expect(panel._currentMessage()).toBe(messages[2000]);
        expect(panel.element.querySelector(".linter-row.current")?.dataset.visibleIndex).toBe(
          "2000",
        );
      } finally {
        editor.destroy();
      }
    });

    it("reveals a different cursor row after the user scrolls away", async () => {
      const editor = await lumine.workspace.open();
      try {
        editor.setText("x\n".repeat(TOTAL));
        editor.setCursorBufferPosition([2000, 0]);
        panel.setEditor(editor);
        await panel.update();
        await panel.update();
        scrollContainer().scrollTop = 4000 * panel._rowHeight;
        panel._onScroll();
        await panel.update();

        editor.setCursorBufferPosition([2500, 0]);
        window.advanceClock(100);
        await panel.update();

        const container = scrollContainer();
        const rowTop = 2500 * panel._rowHeight;
        expect(container.scrollTop).toBeLessThanOrEqual(rowTop);
        expect(container.scrollTop + container.clientHeight).toBeGreaterThanOrEqual(
          rowTop + panel._rowHeight,
        );
        expect(panel._currentMessage()).toBe(messages[2500]);
      } finally {
        editor.destroy();
      }
    });

    it("starts keyboard navigation from the current message outside the viewport", async () => {
      const editor = await lumine.workspace.open();
      try {
        editor.setText("x\n".repeat(TOTAL));
        editor.setCursorBufferPosition([2000, 0]);
        panel.setEditor(editor);
        await panel.update();
        await panel.update();
        scrollContainer().scrollTop = 4000 * panel._rowHeight;
        panel._onScroll();
        await panel.update();
        expect(panel.element.querySelector(".linter-row.current")).toBeNull();

        panel._moveFocus(1);
        await panel.update();

        expect(panel._focusedMessage).toBe(messages[2001]);
      } finally {
        editor.destroy();
      }
    });
  });

  // The panel is built at activation and updated on every publish, whether or
  // not it was ever opened. It used to answer that with a full bootstrap window
  // — 200 rows, markdown and all — because a panel nobody can see measures no
  // row height, which is the same condition as a first render.
  describe("while nothing can see it", () => {
    const rowCount = () => panel.element.querySelectorAll(".linter-row").length;

    it("renders no rows once it leaves the document", async () => {
      await publish(["error", "warning", "info"]);
      expect(rowCount()).toBe(3);

      panel.element.remove();
      await panel.update();

      expect(rowCount()).toBe(0);
    });

    it("renders no rows while an ancestor is hiding it", async () => {
      await publish(["error", "warning"]);
      panel.element.style.display = "none";
      await panel.update();
      expect(rowCount()).toBe(0);

      panel.element.style.display = "";
      await panel.update();
      expect(rowCount()).toBe(2);
    });

    it("does not sort the list it is not rendering", async () => {
      await publish(["error", "warning"]);
      panel.element.remove();
      const visible = spyOn(panel, "_visibleMessages").and.callThrough();

      await panel.update();

      expect(visible).not.toHaveBeenCalled();
    });

    // The whole point of the guard above: a panel that renders nothing until it
    // is seen has to render as soon as it is. Opened as a real pane item rather
    // than attached by hand, so this covers the path a user takes.
    it("renders as soon as it is opened in the workspace", async () => {
      jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
      panel.element.remove();
      await publish(["error", "warning"]);
      expect(rowCount()).toBe(0);

      await panel.toggle();

      expect(panel._isOnScreen()).toBe(true);
      expect(rowCount()).toBe(2);

      await panel.toggle();
      expect(panel._isOnScreen()).toBe(false);
    });

    // A dock closes by shrinking a mask over content that keeps its own size,
    // so neither the element nor the ResizeObserver on it notices. Without a
    // subscription to the dock the panel would come back empty.
    it("follows the dock it lives in being closed and reopened", async () => {
      jasmine.attachToDOM(lumine.views.getView(lumine.workspace));
      panel.element.remove();
      await publish(["error"]);
      await panel.toggle();
      expect(rowCount()).toBe(1);

      const dock = lumine.workspace.paneContainerForItem(panel);
      dock.hide();
      await conditionPromise(() => rowCount() === 0);

      dock.show();
      await conditionPromise(() => rowCount() === 1);
    });

    // Runs on every cursor move as well, so it is the one that costs while
    // typing rather than the one that costs while linting.
    it("does not look for the cursor's row", async () => {
      const editor = await lumine.workspace.open();
      panel.setEditor(editor);
      await publish(["error"]);
      panel.element.remove();
      const sorted = spyOn(panel, "_getSortedMessages").and.callThrough();

      panel._updateCurrentRowHighlight();

      expect(sorted).not.toHaveBeenCalled();
      editor.destroy();
    });
  });

  // A buffer that has never been saved has no path, so its messages name the
  // buffer. The panel has to label and navigate them without one.
  describe("a message with no file path", () => {
    let editor;

    const publishBufferMessage = async () => {
      messages = [
        {
          severity: "error",
          excerpt: "no such word",
          linterName: "spec",
          location: {
            buffer: editor.getBuffer(),
            position: [
              [0, 6],
              [0, 9],
            ],
          },
        },
      ];
      normalize(messages);
      front.render({ messages });
      await panel.update();
    };

    beforeEach(async () => {
      editor = await lumine.workspace.open();
      editor.setText("const foo = 1;\n");
      front.setViewMode("project");
      await panel.update();
    });

    afterEach(() => {
      editor.destroy();
    });

    it("labels the row untitled rather than leaving the cell blank", async () => {
      await publishBufferMessage();

      const row = panel.element.querySelector(".linter-row");
      expect(row.querySelector(".linter-file-path").textContent).toBe("untitled");
    });

    it("reveals it through the workspace in the editor's shared scroll zone", async () => {
      const open = spyOn(lumine.workspace, "open").and.callThrough();
      const requestedScroll = jasmine.createSpy("requested scroll");
      editor.onDidRequestAutoscroll(requestedScroll);
      lumine.config.set("editor.scrollZone", [25, 75]);
      await publishBufferMessage();

      await panel._openMessage(messages[0]);

      expect(open).toHaveBeenCalledWith(editor, { searchAllPanes: true });
      expect(editor.getCursorBufferPosition()).toEqual([0, 6]);
      expect(requestedScroll.calls.mostRecent().args[0].options.mode).toEqual([25, 75]);
    });

    it("does nothing when no editor is showing the buffer any more", async () => {
      await publishBufferMessage();
      const orphan = { getPath: () => null };
      messages[0].location.buffer = orphan;
      const open = spyOn(lumine.workspace, "open").and.callThrough();

      panel.element.querySelector(".linter-row").click();

      expect(open).not.toHaveBeenCalled();
    });
  });
});
