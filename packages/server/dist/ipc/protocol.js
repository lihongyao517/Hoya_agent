export function encodeMessage(message) {
    return `${JSON.stringify(message)}\n`;
}
export function parseRequestLine(line) {
    const value = JSON.parse(line);
    return value;
}
export function parseResponseLine(line) {
    const value = JSON.parse(line);
    return value;
}
//# sourceMappingURL=protocol.js.map