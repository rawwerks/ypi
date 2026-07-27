#!/usr/bin/env node

import { runImplementerRecoveryCli } from "../extensions/ypi/internal/implementer-recovery/cli.ts";

process.exitCode = runImplementerRecoveryCli(process.argv.slice(2));
