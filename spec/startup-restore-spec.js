describe("linter-panel startup restoration", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.getLoadedPackage("linter-panel"))
      await lumine.packages.unloadPackage("linter-panel", { serialize: false });
    pack = lumine.packages.loadPackage("linter-panel");
    pack.initializeForExternalUse("startup restoration spec");
  });

  afterEach(async () => {
    if (lumine.packages.getLoadedPackage("linter-panel"))
      await lumine.packages.unloadPackage("linter-panel", { serialize: false });
  });

  it("destroys a restored panel when startup stops before activation", async () => {
    const panel = pack.mainModule.deserializePanel();
    spyOn(panel, "destroy").and.callThrough();
    await pack.deactivate();
    expect(panel.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the restored panel when activation follows", async () => {
    const panel = pack.mainModule.deserializePanel();
    await lumine.packages.activatePackage("linter-panel");
    expect(pack.mainModule.deserializePanel()).toBe(panel);
    await pack.deactivate();
  });
});
