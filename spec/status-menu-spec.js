const { fakeHub } = require("./fake-hub");

describe("Diagnostics status action menu", () => {
  let tile, editor, cursorEditor, main, hub, messages;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    main = (await lumine.packages.activatePackage("diagnostics")).mainModule;
    editor = await lumine.workspace.open();
    editor.getElement().focus();
    cursorEditor = editor;
    messages = [];
    hub = fakeHub({ messages: () => messages, editor: () => cursorEditor });
    main.provideLinterUI().attach(hub);
    tile = lumine.workspace.getElement().querySelector(".diagnostics-status");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("diagnostics");
  });
  it("shows all actions and reflects the current view mode", async () => {
    const menu = () => lumine.contextMenu.templateForElement(tile);
    expect(
      menu()
        .filter((item) => item.command)
        .map((item) => item.command),
    ).toEqual([
      "diagnostics:toggle",
      "diagnostics:toggle-focus",
      "diagnostics:next",
      "diagnostics:previous",
      "diagnostics:file-mode",
      "diagnostics:project-mode",
      "diagnostics:clear",
    ]);
    expect(menu().find((item) => item.command === "diagnostics:file-mode").checked).toBe(true);
    await lumine.commands.dispatch(tile, "diagnostics:project-mode");
    expect(menu().find((item) => item.command === "diagnostics:file-mode").checked).toBe(false);
    expect(menu().find((item) => item.command === "diagnostics:project-mode").checked).toBe(true);
  });
  it("gives application-menu aliases the same exclusive mode state", async () => {
    const state = (command) =>
      lumine.commands.getCommandState(command, { target: editor.getElement() });
    expect(state("diagnostics:toggle")).toBeNull();
    expect(state("diagnostics:toggle-focus")).toBeNull();
    expect(state("diagnostics:file-mode")).toEqual({ type: "radio", checked: true });
    expect(state("diagnostics:project-mode")).toEqual({ type: "radio", checked: false });
    await lumine.commands.dispatch(editor.getElement(), "diagnostics:project-mode");
    expect(state("diagnostics:file-mode")).toEqual({ type: "radio", checked: false });
    expect(state("diagnostics:project-mode")).toEqual({ type: "radio", checked: true });
  });
  it("shows Alt-L only for focusing and navigation shortcuts only while an editor has focus", () => {
    const keys = lumine.keymaps.add("diagnostics-status-editor-shortcuts-spec", {
      "lumine-text-editor:not([mini])": {
        "alt-'": "diagnostics:next",
        "alt-;": "diagnostics:previous",
      },
    });
    try {
      const menu = () => lumine.contextMenu.templateForElement(tile);
      const items = menu();
      const label = process.platform === "darwin" ? "⌥L" : "Alt+L";
      expect(
        items.find((item) => item.command === "diagnostics:toggle").keyBindingLabel,
      ).toBeUndefined();
      expect(
        items.find((item) => item.command === "diagnostics:toggle-focus").keyBindingLabel,
      ).toBe(label);
      expect(items.find((item) => item.command === "diagnostics:next").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥'" : "Alt+'",
      );
      expect(items.find((item) => item.command === "diagnostics:previous").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥;" : "Alt+;",
      );
      const popup = lumine.contextMenu.show(tile, items);
      try {
        expect(
          popup.rootList.items.find((item) => item.template.command === "diagnostics:toggle-focus")
            .keystrokeElement.textContent,
        ).toBe(label);
        expect(
          popup.rootList.items.find((item) => item.template.command === "diagnostics:toggle")
            .keystrokeElement.textContent,
        ).toBe("");
      } finally {
        popup.close();
      }
      cursorEditor = null;
      lumine.packages
        .getActivePackage("diagnostics")
        .mainModule.provideLinterUI()
        .didChangeActiveItem();
      expect(menu().find((item) => item.command === "diagnostics:next").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥'" : "Alt+'",
      );
      const button = document.createElement("button");
      lumine.workspace.getElement().appendChild(button);
      try {
        button.focus();
        expect(
          menu().find((item) => item.command === "diagnostics:next").keyBindingLabel,
        ).toBeUndefined();
      } finally {
        button.remove();
      }
    } finally {
      keys.dispose();
    }
  });
  it("dispatches popular gestures through menu commands without right-button effects", () => {
    const dispatch = spyOn(lumine.commands, "dispatch");
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 2, bubbles: true }));
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 2, ctrlKey: true, bubbles: true }));
    lumine.contextMenu.templateForElement(tile);
    expect(dispatch).not.toHaveBeenCalled();
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 1 }));
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 0, metaKey: true }));
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 0, shiftKey: true }));
    expect(dispatch.calls.allArgs()).toEqual([
      [tile, "diagnostics:toggle"],
      [tile, "diagnostics:project-mode"],
      [tile, "diagnostics:next"],
      [tile, "diagnostics:previous"],
    ]);
  });
  it("disposes menus and retained mouse listeners", async () => {
    await lumine.packages.deactivatePackage("diagnostics");
    const dispatch = spyOn(lumine.commands, "dispatch");
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(lumine.contextMenu.templateForElement(tile)).toEqual([]);
  });

  it("dispatches its own actions through the connected backend and disables them on detach", async () => {
    const next = spyOn(hub, "nextMessage");
    const previous = spyOn(hub, "previousMessage");
    const clear = spyOn(hub, "clearMessages");
    const commands = ["diagnostics:next", "diagnostics:previous", "diagnostics:clear"];
    for (const command of commands) {
      expect(lumine.commands.canDispatch(tile, command)).toBe(false);
    }
    messages = [{ severity: "warning", excerpt: "warning" }];
    main.provideLinterUI().render({ messages });
    for (const command of commands) {
      expect(lumine.commands.canDispatch(tile, command)).toBe(true);
      await lumine.commands.dispatch(tile, command);
    }
    expect(next).toHaveBeenCalledTimes(1);
    expect(previous).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledTimes(1);

    main.provideLinterUI().dispose();
    for (const command of commands) {
      expect(lumine.commands.canDispatch(tile, command)).toBe(false);
    }
  });

  it("opens the project view repeatedly without toggling an already visible panel closed", async () => {
    const provider = main.provideLinterUI();
    await provider.showProjectView();
    const panel = main.deserializePanel();
    expect(panel.getTitle()).toBe("Diagnostics");
    expect(panel.pkg.viewMode).toBe("project");
    expect(lumine.workspace.paneForItem(panel)).toBeTruthy();
    expect(lumine.workspace.getBottomDock().isVisible()).toBe(true);

    await provider.showProjectView();
    expect(main.deserializePanel()).toBe(panel);
    expect(lumine.workspace.getBottomDock().isVisible()).toBe(true);
  });
});
