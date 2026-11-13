// The CLI discovers/sorts paths alphabetically. The public runner's explicit
// files array preserves our scheduling order while keeping process isolation.
import {run} from 'node:test';
import {tap} from 'node:test/reporters';
import {availableParallelism} from 'node:os';
import {pipeline} from 'node:stream/promises';
const [concurrency,...files]=process.argv.slice(2);
if(!files.length)throw new Error('No test files selected');
const stream=run({files,isolation:'process',concurrency:concurrency==='auto'?Math.max(1,availableParallelism()-1):Number(concurrency),execArgv:['--import','tsx']});
stream.on('test:fail',()=>{process.exitCode=1;});
await pipeline(stream,tap,process.stdout);
