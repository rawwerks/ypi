#!/usr/bin/env node

import { runImplementerLaunchGateCli } from "../extensions/ypi/internal/launch-gate.ts";

process.exitCode = runImplementerLaunchGateCli(process.argv.slice(2));
