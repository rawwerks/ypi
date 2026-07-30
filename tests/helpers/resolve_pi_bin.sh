#!/bin/bash

resolve_ypi_pi_bin() {
    local project_dir="$1" candidate

    if [ -n "${YPI_PI_BIN:-}" ]; then
        command -v "$YPI_PI_BIN" 2>/dev/null || printf '%s\n' "$YPI_PI_BIN"
        return
    fi

    for candidate in \
        "$project_dir/../.bin/pi" \
        "$project_dir/node_modules/.bin/pi" \
        "$project_dir/../@earendil-works/pi-coding-agent/dist/cli.js" \
        "$project_dir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"; do
        if [ -x "$candidate" ]; then
            printf '%s\n' "$candidate"
            return
        fi
    done

    command -v pi 2>/dev/null || true
}
