$env:ELECTRON_RUN_AS_NODE = "1"
& "$env:LOCALAPPDATA/Programs/Microsoft VS Code/Code.exe" scripts/serve.mjs 8787
exit $LASTEXITCODE
