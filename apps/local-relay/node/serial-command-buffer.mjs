export class SerialCommandBuffer {
  #commands = new Map();

  get size() {
    return this.#commands.size;
  }

  defer(command, currentCommandId) {
    const commandId = command?.id;
    if (typeof commandId !== "string" || !commandId) {
      throw new Error("Deferred relay command must have an id");
    }
    if (commandId === currentCommandId || this.#commands.has(commandId)) {
      return "duplicate";
    }
    this.#commands.set(commandId, command);
    return "queued";
  }

  delete(commandId) {
    return this.#commands.delete(commandId);
  }

  shift() {
    const entry = this.#commands.entries().next();
    if (entry.done) return null;
    const [commandId, command] = entry.value;
    this.#commands.delete(commandId);
    return command;
  }
}
