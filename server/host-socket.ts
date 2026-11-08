import type { Socket } from "node:net";
import type { Interface } from "node:readline";

/** A peer disconnect is local to this RPC, including readline's forwarded error. */
export function guardHostSocket(socket: Socket, input: Interface): void {
  const disconnect = () => socket.destroy();
  socket.on("error", disconnect);
  input.on("error", disconnect);
}
