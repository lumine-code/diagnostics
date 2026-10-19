const { Front } = require("../lib/front");
const { fakeHub } = require("./fake-hub");

// What both surfaces read comes from the hub, and the hub answers about the
// active item from state it updates on the same workspace event a front end
// would subscribe to. So it must not subscribe: it is told.
describe("lib/front", () => {
  let front;
  let editor;

  beforeEach(() => {
    front = new Front();
    front.attach(fakeHub({ editor: () => lumine.workspace.getCenter().getActivePaneItem() }));
  });

  afterEach(() => {
    front.dispose();
    editor?.destroy();
  });

  it("does not follow the workspace on its own", async () => {
    editor = await lumine.workspace.open("front-spec.js");

    // The active item moved, and the hub would answer with it — but nothing has
    // said the hub has caught up, so neither has this.
    expect(front.editor).toBeNull();
  });

  it("takes the editor from the hub when it is told", async () => {
    editor = await lumine.workspace.open("front-spec.js");

    front.setEditor();

    expect(front.editor).toBe(editor);
  });

  it("passes it on to whichever surfaces exist", async () => {
    const seen = [];
    front.status = { setEditor: (value) => seen.push(value), update: () => {} };
    editor = await lumine.workspace.open("front-spec.js");

    front.setEditor();

    expect(seen[seen.length - 1]).toBe(editor);
  });

  it("keeps cursor lookup optional for hubs with only the original handle", () => {
    expect(front.getMessagesAtPosition(null, { row: 0, column: 0 })).toBeNull();
  });

  it("forwards indexed cursor lookup without scanning messages itself", () => {
    const hub = fakeHub();
    const position = { row: 3, column: 2 };
    const messages = [{ key: "diagnostic" }];
    hub.getMessagesAtPosition = jasmine
      .createSpy("getMessagesAtPosition")
      .and.returnValue(messages);
    front.attach(hub);

    expect(front.getMessagesAtPosition(null, position)).toBe(messages);
    expect(hub.getMessagesAtPosition).toHaveBeenCalledOnceWith(null, position);
  });

  it("uses the attached backend for navigation and clearing and stops after detaching", () => {
    const hub = fakeHub();
    const next = spyOn(hub, "nextMessage").and.returnValue("next");
    const previous = spyOn(hub, "previousMessage").and.returnValue("previous");
    const clear = spyOn(hub, "clearMessages").and.returnValue("cleared");
    front.attach(hub);

    expect(front.nextMessage()).toBe("next");
    expect(front.previousMessage()).toBe("previous");
    expect(front.clearMessages()).toBe("cleared");
    front.detach();
    expect(front.nextMessage()).toBeUndefined();
    expect(front.previousMessage()).toBeUndefined();
    expect(front.clearMessages()).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);
  });
});
