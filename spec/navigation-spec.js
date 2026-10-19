const { Diagnostics } = require("../lib/diagnostics");
const { Front } = require("../lib/front");
const { fakeHub, normalize } = require("./fake-hub");

describe("Panel diagnostic navigation", () => {
  let panel;
  let front;
  let messages;
  let currentMessages;
  let cursorEditor;
  let editors;

  const diagnostic = (excerpt, row = 0, severity = "warning", file = "/a.js") => ({
    severity,
    excerpt,
    location: {
      file,
      position: [
        [row, 0],
        [row, 1],
      ],
    },
  });
  const buttons = () => Array.from(panel.element.querySelectorAll("button.diagnostics-navigation"));
  const clearButton = () => panel.element.querySelector("button.diagnostics-clear");
  const publish = async (next) => {
    messages = normalize(next);
    front.render({ messages });
    await panel.update();
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  beforeEach(async () => {
    lumine.config.set("diagnostics.defaultSortMethod", "position");
    messages = [];
    currentMessages = null;
    cursorEditor = null;
    editors = [];
    front = new Front();
    front.attach(
      fakeHub({
        messages: () => messages,
        current: () => currentMessages ?? messages,
        editor: () => cursorEditor,
      }),
    );
    panel = new Diagnostics(front);
    front.panel = panel;
    jasmine.attachToDOM(panel.element);
    await panel.update();
  });

  afterEach(async () => {
    if (panel && !panel.destroyed) await panel.destroy();
    front.dispose();
    for (const editor of editors) editor.destroy();
  });

  it("wires accessible previous and next buttons and disables them for an empty list", async () => {
    const [previous, next] = buttons();
    expect(previous.getAttribute("aria-label")).toBe("Previous Diagnostic");
    expect(next.getAttribute("aria-label")).toBe("Next Diagnostic");
    expect(previous.disabled).toBe(true);
    expect(next.disabled).toBe(true);
    const navigate = spyOn(panel, "_navigateMessage");
    previous.click();
    next.click();
    expect(navigate).not.toHaveBeenCalled();

    await publish([diagnostic("one")]);
    expect(previous.disabled).toBe(false);
    expect(next.disabled).toBe(false);
    previous.click();
    next.click();
    expect(navigate.calls.allArgs()).toEqual([[-1], [1]]);
  });

  it("does nothing when navigation is called on an empty or fully filtered list", async () => {
    const reveal = spyOn(front, "revealMessage");
    await panel._navigateMessage(1);
    await publish([diagnostic("one")]);
    panel.toggleVisibility("warning");
    await panel.update();
    await panel._navigateMessage(-1);
    expect(reveal).not.toHaveBeenCalled();
    expect(buttons().every((button) => button.disabled)).toBe(true);

    panel.toggleVisibility("warning");
    await panel.update();
    expect(buttons().every((button) => !button.disabled)).toBe(true);
    await panel._navigateMessage(1);
    expect(reveal).toHaveBeenCalledOnceWith(messages[0]);
  });

  it("disables clearing an empty or disconnected hub and guards direct calls", async () => {
    const clear = spyOn(front, "clearMessages");
    expect(clearButton().getAttribute("aria-label")).toBe("Clear All Diagnostics");
    expect(clearButton().disabled).toBe(true);
    clearButton().click();
    panel._clearMessages();

    await publish([diagnostic("one")]);
    expect(clearButton().disabled).toBe(false);
    front.detach();
    await panel.update();
    expect(clearButton().disabled).toBe(true);
    clearButton().click();
    panel._clearMessages();
    expect(clear).not.toHaveBeenCalled();
  });

  it("clears all diagnostics even when the current file or severity filter shows none", async () => {
    currentMessages = [];
    await publish([diagnostic("another file", 0, "warning", "/b.js")]);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(clearButton().disabled).toBe(false);
    const clear = spyOn(front.hub, "clearMessages");
    clearButton().click();
    expect(clear).toHaveBeenCalledTimes(1);

    front.setViewMode("project");
    panel.toggleVisibility("warning");
    await panel.update();
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(clearButton().disabled).toBe(false);
    clearButton().click();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it("follows descending panel sort and severity filters while wrapping at both ends", async () => {
    await publish([
      diagnostic("error", 0, "error"),
      diagnostic("warning", 1),
      diagnostic("info", 2, "info"),
      diagnostic("hint", 3, "hint"),
    ]);
    panel.setSortMethod("severity");
    panel.setSortMethod("severity");
    panel.toggleVisibility("warning");
    await panel.update();
    const reveal = spyOn(front, "revealMessage");

    for (let step = 0; step < 4; step++) await panel._navigateMessage(1);
    await panel._navigateMessage(-1);

    expect(reveal.calls.allArgs().map(([message]) => message.excerpt)).toEqual([
      "hint",
      "info",
      "error",
      "hint",
      "error",
    ]);
  });

  it("enters from the last message for previous and wraps to the first for next", async () => {
    await publish([diagnostic("first", 0), diagnostic("last", 1)]);
    const reveal = spyOn(front, "revealMessage");
    await panel._navigateMessage(-1);
    await panel._navigateMessage(1);
    expect(reveal.calls.allArgs()).toEqual([[messages[1]], [messages[0]]]);
  });

  it("starts from the keyboard selection ahead of an earlier button navigation anchor", async () => {
    await publish([diagnostic("first", 0), diagnostic("second", 1), diagnostic("third", 2)]);
    const reveal = spyOn(front, "revealMessage");
    await panel._navigateMessage(1);
    panel._setFocusedMessage(messages[1]);
    await panel.update();
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([messages[2]]);
    expect(panel._focusedMessage).toBeNull();
  });

  it("advances through messages at the same cursor position after focus leaves the panel", async () => {
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setText("a\nb\nc\n");
    editor.setCursorBufferPosition([1, 0]);
    cursorEditor = editor;
    front.hub.getMessagesAtPosition = () => messages;
    front.setEditor();
    await publish([diagnostic("first", 1), diagnostic("second", 1), diagnostic("third", 1)]);
    const reveal = spyOn(front, "revealMessage").and.callFake(() => {
      panel.element.dispatchEvent(new FocusEvent("focusout", { relatedTarget: editor.element }));
    });

    await panel._navigateMessage(1);
    expect(panel._currentMessage()).toBe(messages[1]);
    await panel._navigateMessage(1);
    expect(panel._currentMessage()).toBe(messages[2]);
    await panel._navigateMessage(1);
    expect(panel._currentMessage()).toBe(messages[0]);

    expect(reveal.calls.allArgs()).toEqual([[messages[1]], [messages[2]], [messages[0]]]);
  });

  it("uses only current-file messages in file mode and opens the full project after switching mode", async () => {
    const own = diagnostic("own", 0, "warning", "/b.js");
    const foreign = diagnostic("foreign", 0, "warning", "/a.js");
    currentMessages = [own];
    await publish([foreign, own]);
    const reveal = spyOn(front, "revealMessage");
    const open = spyOn(panel, "_openMessage");
    await panel._navigateMessage(1);
    await panel._navigateMessage(1);
    expect(reveal.calls.allArgs()).toEqual([[own], [own]]);
    expect(open).not.toHaveBeenCalled();

    front.setViewMode("project");
    await panel.update();
    await panel._navigateMessage(1);
    expect(open).toHaveBeenCalledOnceWith(foreign);
  });

  it("keeps its project position when opening another file resets the current editor", async () => {
    const firstEditor = await lumine.workspace.open();
    const secondEditor = await lumine.workspace.open();
    editors.push(firstEditor, secondEditor);
    await publish([
      diagnostic("first", 1, "warning", "/a.js"),
      diagnostic("second", 2, "warning", "/b.js"),
    ]);
    front.setViewMode("project");
    await panel.update();
    const open = spyOn(lumine.workspace, "open").and.callFake((file) => {
      currentMessages = messages.filter((message) => message.location.file === file);
      cursorEditor = file === "/a.js" ? firstEditor : secondEditor;
      front.setEditor();
      return Promise.resolve(cursorEditor);
    });

    await panel._navigateMessage(1);
    await panel._navigateMessage(1);
    await panel._navigateMessage(1);

    expect(open.calls.allArgs().map(([file]) => file)).toEqual(["/a.js", "/b.js", "/a.js"]);
    expect(open.calls.first().args[1]).toEqual({
      initialLine: 1,
      initialColumn: 0,
      pending: true,
      searchAllPanes: true,
    });
  });

  it("retains the anchor across replacement objects and drops it when removed or filtered out", async () => {
    await publish([
      diagnostic("first", 0, "error"),
      diagnostic("second", 1),
      diagnostic("third", 2),
    ]);
    const reveal = spyOn(front, "revealMessage");
    await panel._navigateMessage(1);
    const replacement = { ...messages[0], description: "updated" };
    await publish([replacement, messages[1], messages[2]]);
    expect(panel._navigationMessage).toBe(replacement);
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([messages[1]]);

    await publish([messages[0], messages[2]]);
    expect(panel._navigationMessage).toBeNull();
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([replacement]);
    panel.toggleVisibility("error");
    await panel.update();
    expect(panel._navigationMessage).toBeNull();
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([messages[1]]);
  });

  it("disables both buttons during an asynchronous reveal and ignores concurrent navigation", async () => {
    await publish([diagnostic("first", 0), diagnostic("second", 1)]);
    const pending = deferred();
    const reveal = spyOn(front, "revealMessage").and.returnValue(pending.promise);
    const navigation = panel._navigateMessage(1);
    await conditionPromise(() => reveal.calls.count() === 1);
    expect(buttons().every((button) => button.disabled)).toBe(true);
    expect(clearButton().disabled).toBe(true);
    const dispatch = spyOn(lumine.commands, "dispatch");
    panel._clearMessages();
    expect(dispatch).not.toHaveBeenCalled();
    await panel._navigateMessage(1);
    expect(reveal).toHaveBeenCalledTimes(1);

    pending.resolve();
    await navigation;
    expect(buttons().every((button) => !button.disabled)).toBe(true);
    expect(clearButton().disabled).toBe(false);
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([messages[1]]);
  });

  it("unlocks navigation after a reveal fails", async () => {
    await publish([diagnostic("first", 0), diagnostic("second", 1)]);
    const reveal = spyOn(front, "revealMessage").and.callFake(() =>
      Promise.reject(new Error("failed")),
    );
    await expectAsync(panel._navigateMessage(1)).toBeRejectedWithError("failed");
    expect(panel._navigating).toBe(false);
    expect(buttons().every((button) => !button.disabled)).toBe(true);

    reveal.and.returnValue(undefined);
    await panel._navigateMessage(1);
    expect(reveal.calls.mostRecent().args).toEqual([messages[1]]);
  });

  it("abandons a project target when the scope changes before navigation renders", async () => {
    await publish([diagnostic("foreign", 0, "warning", "/b.js")]);
    front.setViewMode("project");
    await panel.update();
    const pending = deferred();
    spyOn(panel, "update").and.returnValue(pending.promise);
    const open = spyOn(panel, "_openMessage");
    const reveal = spyOn(front, "revealMessage");
    const navigation = panel._navigateMessage(1);
    front.setViewMode("file");
    pending.resolve();
    await navigation;
    expect(open).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
    expect(panel._navigating).toBe(false);
  });

  for (const change of ["removed", "filtered"]) {
    it(`abandons a target ${change} before navigation renders`, async () => {
      await publish([diagnostic("first", 0, "error"), diagnostic("second", 1)]);
      const pending = deferred();
      spyOn(panel, "update").and.returnValue(pending.promise);
      const reveal = spyOn(front, "revealMessage");
      const navigation = panel._navigateMessage(1);
      if (change === "removed") {
        messages = messages.slice(1);
        front.render({ messages });
      } else {
        panel.toggleVisibility("error");
      }
      pending.resolve();
      await navigation;
      expect(reveal).not.toHaveBeenCalled();
      expect(panel._navigating).toBe(false);
    });
  }

  it("reveals the latest canonical target when metadata changes before navigation renders", async () => {
    await publish([diagnostic("first")]);
    const pending = deferred();
    spyOn(panel, "update").and.returnValue(pending.promise);
    const reveal = spyOn(front, "revealMessage");
    const navigation = panel._navigateMessage(1);
    const replacement = { ...messages[0], description: "updated" };
    messages = [replacement];
    front.render({ messages, updated: [replacement], added: [], removed: [] });
    pending.resolve();
    await navigation;
    expect(reveal).toHaveBeenCalledOnceWith(replacement);
  });

  it("does not update the panel after destruction while a reveal is pending", async () => {
    await publish([diagnostic("first")]);
    const pending = deferred();
    const reveal = spyOn(front, "revealMessage").and.returnValue(pending.promise);
    const navigation = panel._navigateMessage(1);
    await conditionPromise(() => reveal.calls.count() === 1);
    const update = spyOn(panel, "update").and.callThrough();
    await panel.destroy();
    update.calls.reset();
    pending.resolve();
    await navigation;
    expect(update).not.toHaveBeenCalled();
  });

  it("drops the button anchor when the user moves the editor cursor", async () => {
    const editor = await lumine.workspace.open();
    editors.push(editor);
    editor.setText("a\nb\nc\n");
    cursorEditor = editor;
    front.setEditor();
    await publish([diagnostic("first", 0), diagnostic("second", 1)]);
    spyOn(front, "revealMessage");
    await panel._navigateMessage(1);
    expect(panel._navigationMessage).not.toBeNull();

    editor.setCursorBufferPosition([2, 0]);
    expect(panel._navigationMessage).toBeNull();
  });
});
