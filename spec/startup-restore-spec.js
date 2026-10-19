describe("diagnostics startup restoration", () => {
  let pack;

  beforeEach(async () => {
    if (lumine.packages.getLoadedPackage("diagnostics"))
      await lumine.packages.unloadPackage("diagnostics", { serialize: false });
    pack = lumine.packages.loadPackage("diagnostics");
    pack.initializeForExternalUse("startup restoration spec");
  });

  afterEach(async () => {
    if (lumine.packages.getLoadedPackage("diagnostics"))
      await lumine.packages.unloadPackage("diagnostics", { serialize: false });
  });

  it("destroys a restored panel when startup stops before activation", async () => {
    const panel = pack.mainModule.deserializePanel();
    spyOn(panel, "destroy").and.callThrough();
    await pack.deactivate();
    expect(panel.destroy).toHaveBeenCalledTimes(1);
  });

  it("keeps the restored panel when activation follows", async () => {
    const panel = pack.mainModule.deserializePanel();
    await lumine.packages.activatePackage("diagnostics");
    expect(pack.mainModule.deserializePanel()).toBe(panel);
    await pack.deactivate();
  });
});
