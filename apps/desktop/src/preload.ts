import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("cohubDesktop", {
	signIn: () => ipcRenderer.invoke("cohub-desktop:sign-in"),
});
