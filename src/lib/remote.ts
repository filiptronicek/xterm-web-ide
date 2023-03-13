import { webSocketSettings } from "../client";
import { IXtermWindow } from "./types";

declare let window: IXtermWindow;

export const resizeRemoteTerminal = (size: { cols: number; rows: number }, pid: number) => {
    if (!pid) {
        return;
    }
    const cols = size.cols;
    const rows = size.rows;
    const url = `/terminals/${pid}/size?cols=${cols}&rows=${rows}`;

    fetch(url, { method: "POST" });
}

export const initiateRemoteCommunicationChannelSocket = async (protocol: string) => {
    const ReconnectingWebSocket = (await import("reconnecting-websocket")).default;
    const socket = new ReconnectingWebSocket(`${protocol + location.hostname + (location.port ? ":" + location.port : "")}/terminals/remote-communication-channel/`, [], webSocketSettings);

    socket.onopen = () => {
        console.debug("External messaging channel socket opened");
    };

    socket.onmessage = (event) => {
        if (!event.data) {
            console.warn("Received empty message");
            return;
        }

        const messageData = JSON.parse(event.data);
        if (window.handledMessages.includes(messageData.id)) {
            console.debug(`Message already handled: ${messageData.id}`);
            return;
        }

        if (messageData.action === "openUrl") {
            const url = messageData.data;
            console.debug(`Opening URL: ${url}`);
            window.open(url, "_blank");
        }

        window.handledMessages.push(messageData.id);
        console.debug(`Handled message: ${messageData.id}`);
    };
};
