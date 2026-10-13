const { fakeHub } = require("./fake-hub");

describe("Linter status action menu", () => {
  let tile;
  beforeEach(async () => {
    jasmine.useRealClock();
    jasmine.attachToDOM(lumine.workspace.getElement());
    await lumine.packages.activatePackage("status-bar");
    const main = (await lumine.packages.activatePackage("linter-panel")).mainModule;
    const editor = await lumine.workspace.open();
    main.provideLinterUI().attach(fakeHub({ editor: () => editor }));
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
