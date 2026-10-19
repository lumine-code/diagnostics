// Authentic package usage. Run with lumine/script/demo.js; fixtures stay in demo/.
module.exports = {
  version: 1,
  dependencies: [
    "language-typescript",
    "marker",
    "linter",
    "documentation-view",
    "hover",
    "ide",
    "ide-typescript",
  ],
  viewport: { width: 1100, height: 490 },
  async before(context) {
    const { lumine, state } = context;
    for (const p of lumine.packages.getActivePackages())
      if (
        p.name.startsWith("ide-") &&
        p.name !== "ide-typescript" &&
        state.serverInstall?.[p.name]?.status !== "installing"
      )
        await lumine.packages.deactivatePackage(p.name);
  },
  async prepare(context) {
    const { lumine, state, fixture, open } = context;
    state.editor = await open("editor-features/signal.ts");
    await lumine.project.setPaths([fixture("editor-features")]);
    lumine.grammars.assignLanguageMode(state.editor.getBuffer(), "source.ts");
    await state.editor.getBuffer().getLanguageMode().ready;
    await state.editor.getBuffer().getLanguageMode().atGrammarSettlement?.();
  },
  scenes: [
    {
      id: "scene-1",
      file: "demo.png",
      caption: "Inspect a TypeScript error in the diagnostics panel and its source code.",
      timeout: 60000,
      async run(context) {
        const { lumine, state } = context;
        {
          for (let n = 0; n < 60; n++) {
            if (
              [
                ...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values(),
              ].some((s) => s.adapter.id === "ide-typescript" && s.state === "running") &&
              lumine.packages
                .getActivePackage("linter")
                .mainModule.provideMcpTools()[0]
                .execute({ filePath: state.editor.getPath() })
                .messages.filter((m) => m.linterName === "TypeScript Language Server").length
            )
              break;
            await new Promise((r) => setTimeout(r, 500));
          }
          if (
            ![...lumine.packages.getActivePackage("ide").mainModule.manager.sessions.values()].some(
              (s) => s.adapter.id === "ide-typescript" && s.state === "running",
            )
          )
            throw new Error("The actual language server did not start");
          const messages = lumine.packages
            .getActivePackage("linter")
            .mainModule.provideMcpTools()[0]
            .execute({ filePath: state.editor.getPath() })
            .messages.filter((m) => m.linterName === "TypeScript Language Server");
          if (!messages.length) throw new Error("No diagnostic from the expected server");
          const message = messages.find((m) => m.severity === "error") || messages[0];
          state.evidence = {
            adapter: "ide-typescript",
            provider: message.linterName,
            diagnostic: message.excerpt,
          };
          state.editor.setCursorBufferPosition(message.range.start);
          state.editor.scrollToCursorPosition();
          lumine.views.getView(state.editor).focus();
        }
        {
          await lumine.workspace.open("lumine://diagnostics");
          lumine.workspace.getBottomDock().setState({ size: 160 });
          lumine.workspace.getBottomDock().show();
          context.command("diagnostics:project-mode");
        }
      },
      ready() {
        return Boolean(
          document.querySelector(".diagnostics")?.innerText.includes("not assignable") &&
          document.querySelector(".diagnostics-status-project:not([hidden])") &&
          document.querySelector(".diagnostics-navigation.icon-arrow-left:not(:disabled)") &&
          document.querySelector(".diagnostics-navigation.icon-arrow-right:not(:disabled)") &&
          document.querySelector(".diagnostics-clear:not(:disabled)"),
        );
      },
    },
  ],
  async cleanup() {},
};
