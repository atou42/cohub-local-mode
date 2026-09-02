const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cohubPersonalNode", {
	register: (input) => ipcRenderer.invoke("personal-node:register", input),
	status: () => ipcRenderer.invoke("personal-node:status"),
	onStatus: (listener) => {
		const wrapped = (_event, status) => listener(status);
		ipcRenderer.on("personal-node:status", wrapped);
		return () => ipcRenderer.removeListener("personal-node:status", wrapped);
	},
});
