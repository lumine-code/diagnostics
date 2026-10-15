const { fakeHub } = require("./fake-hub");

describe("Linter status action menu", () => {
  let tile, editor, cursorEditor;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    const main = (await lumine.packages.activatePackage("linter-panel")).mainModule;
    editor = await lumine.workspace.open();
    editor.getElement().focus();
    cursorEditor = editor;
    main.provideLinterUI().attach(fakeHub({ editor: () => cursorEditor }));
    tile = lumine.workspace.getElement().querySelector(".linter-status");
  });
  afterEach(async () => {
    await lumine.packages.deactivatePackage("linter-panel");
  });
  it("shows all actions and reflects the current view mode", async () => {
    const menu = () => lumine.contextMenu.templateForElement(tile);
    expect(
      menu()
        .filter((item) => item.command)
        .map((item) => item.command),
    ).toEqual([
      "linter-panel:toggle",
      "linter-panel:toggle-focus",
      "linter:next",
      "linter:previous",
      "linter-panel:file-mode",
      "linter-panel:project-mode",
      "linter:clear",
    ]);
    expect(menu().find((item) => item.command === "linter-panel:file-mode").checked).toBe(true);
    await lumine.commands.dispatch(tile, "linter-panel:project-mode");
    expect(menu().find((item) => item.command === "linter-panel:file-mode").checked).toBe(false);
    expect(menu().find((item) => item.command === "linter-panel:project-mode").checked).toBe(true);
  });
  it("shows Alt-L only for focusing and navigation shortcuts only while an editor has focus", () => {
    const keys = lumine.keymaps.add("linter-status-editor-shortcuts-spec", {
      "lumine-text-editor:not([mini])": {
        "alt-'": "linter:next",
        "alt-;": "linter:previous",
      },
    });
    try {
      const menu = () => lumine.contextMenu.templateForElement(tile);
      const items = menu();
      const label = process.platform === "darwin" ? "⌥L" : "Alt+L";
      expect(
        items.find((item) => item.command === "linter-panel:toggle").keyBindingLabel,
      ).toBeUndefined();
      expect(
        items.find((item) => item.command === "linter-panel:toggle-focus").keyBindingLabel,
      ).toBe(label);
      expect(items.find((item) => item.command === "linter:next").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥'" : "Alt+'",
      );
      expect(items.find((item) => item.command === "linter:previous").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥;" : "Alt+;",
      );
      const popup = lumine.contextMenu.show(tile, items);
      try {
        expect(
          popup.rootList.items.find((item) => item.template.command === "linter-panel:toggle-focus")
            .keystrokeElement.textContent,
        ).toBe(label);
        expect(
          popup.rootList.items.find((item) => item.template.command === "linter-panel:toggle")
            .keystrokeElement.textContent,
        ).toBe("");
      } finally {
        popup.close();
      }
      cursorEditor = null;
      lumine.packages
        .getActivePackage("linter-panel")
        .mainModule.provideLinterUI()
        .didChangeActiveItem();
      expect(menu().find((item) => item.command === "linter:next").keyBindingLabel).toBe(
        process.platform === "darwin" ? "⌥'" : "Alt+'",
      );
      const button = document.createElement("button");
      lumine.workspace.getElement().appendChild(button);
      try {
        button.focus();
        expect(
          menu().find((item) => item.command === "linter:next").keyBindingLabel,
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
      [tile, "linter-panel:toggle"],
      [tile, "linter-panel:project-mode"],
      [tile, "linter:next"],
      [tile, "linter:previous"],
    ]);
  });
  it("disposes menus and retained mouse listeners", async () => {
    await lumine.packages.deactivatePackage("linter-panel");
    const dispatch = spyOn(lumine.commands, "dispatch");
    tile.dispatchEvent(new MouseEvent("mouseup", { button: 0 }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(lumine.contextMenu.templateForElement(tile)).toEqual([]);
  });
});
