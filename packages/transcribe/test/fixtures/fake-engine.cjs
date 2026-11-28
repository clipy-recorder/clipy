"use strict";

const { appendFileSync, existsSync, writeFileSync } = require("node:fs");

module.exports = {
  OfflineRecognizer: {
    async createAsync() {
      const log = process.env.CLIPY_FAKE_ENGINE_LOG;
      if (log) appendFileSync(log, "load\n");

      const load = process.env.CLIPY_FAKE_ENGINE_LOAD;
      if (load === "throw") throw new Error("fake load error");
      if (load === "exit") process.exit(1);

      let decodes = 0;
      return {
        createStream() {
          return { acceptWaveform() {} };
        },
        async decodeAsync() {
          decodes++;
          const crash = process.env.CLIPY_FAKE_ENGINE_CRASH;
          if (crash === "all") process.exit(1);
          if (crash && decodes === Number(crash)) {
            const marker = process.env.CLIPY_FAKE_ENGINE_MARKER;
            // Marker file survives across restarted children so the crash happens once.
            if (!marker || !existsSync(marker)) {
              if (marker) writeFileSync(marker, "1");
              process.exit(1);
            }
          }
          // Tokens at +5 s land past the 2.5 s overlap and inside each piece's core.
          return { text: "ok", tokens: [" ok"], timestamps: [5] };
        },
      };
    },
  },
};
