# Export each target to its own scope to avoid concurrent overwrites.
target "_common" {
  cache-from = [
    "type=gha,scope=sandbox-runtime",
    "type=gha,scope=sandbox-game",
  ]
}

target "runtime" {
  cache-to = ["type=gha,mode=max,scope=sandbox-runtime"]
}

target "game" {
  cache-to = ["type=gha,mode=max,scope=sandbox-game"]
}
