variable "RUNTIME_TAGS" {
  type    = list(string)
  default = ["cohub-sandbox:latest"]
}
variable "GAME_TAGS" {
  type    = list(string)
  default = ["cohub-sandbox-game:latest"]
}
variable "COHUB_CLI_REFRESH" { default = "0" }
variable "GIT_REVISION" { default = "" }
variable "GIT_VERSION" { default = "" }

group "default" {
  targets = ["runtime", "game"]
}

target "_common" {
  context    = "./apps/sandbox"
  dockerfile = "Dockerfile"
  platforms  = ["linux/amd64"]
  args = {
    COHUB_CLI_REFRESH = COHUB_CLI_REFRESH
  }
  labels = {
    "org.opencontainers.image.source"   = "https://github.com/netaart/cohub"
    "org.opencontainers.image.revision" = GIT_REVISION
    "org.opencontainers.image.version"  = GIT_VERSION
  }
}

target "runtime" {
  inherits = ["_common"]
  target   = "runtime"
  tags     = RUNTIME_TAGS
  labels = {
    "org.opencontainers.image.title"       = "cohub-sandbox"
    "org.opencontainers.image.description" = "Cohub cloud sandbox (default profile)"
  }
}

target "game" {
  inherits = ["_common"]
  target   = "game"
  tags     = GAME_TAGS
  labels = {
    "org.opencontainers.image.title"       = "cohub-sandbox-game"
    "org.opencontainers.image.description" = "Cohub cloud sandbox (game profile)"
  }
}
