/** Fetch retry/abort timers may be unreferenced. An awaited Promise alone
 * does not keep a Node CLI alive: exiting then would skip its receipt and
 * cleanup while systemd incorrectly records success. Hold one event-loop
 * reference until the complete storage operation has settled. */
export async function runStorageProcess<T>(operation:()=>Promise<T>):Promise<T>{
 const alive=setInterval(()=>undefined,30_000);
 try{return await operation();}finally{clearInterval(alive);}
}
