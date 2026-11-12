import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { buildSync } from 'esbuild';
import type { ChildCreation, createApi } from '../src/api.ts';

const bundle = buildSync({entryPoints:['src/api.ts'],bundle:true,write:false,platform:'node',format:'cjs'}).outputFiles[0]!.text;
const module = {exports:{} as {ChildCreation:typeof ChildCreation;createApi:typeof createApi}};
runInNewContext(bundle,{module,exports:module.exports,Error});

void test('creation dispatch uses the matching form once and disposes cleanly across reloads', async () => {
	const dispatch = new module.exports.ChildCreation();const opened:string[]=[];
	const registration={id:'learning',matches:(path:string)=>path.startsWith('learning/'),open:(path:string)=>{opened.push(path);}};
	const remove=dispatch.register(registration);
	assert.equal(await dispatch.tryOpen('work/projects'),false);
	assert.equal(await dispatch.tryOpen('learning/dl/embedding'),true);
	assert.deepEqual(opened,['learning/dl/embedding']);
	assert.throws(()=>dispatch.register(registration),/already registered/);
	remove();const removeNew=dispatch.register(registration);remove();
	assert.equal(await dispatch.tryOpen('learning/dl/embedding'),true);
	removeNew();assert.equal(await dispatch.tryOpen('learning/dl/embedding'),false);
	dispatch.dispose();assert.throws(()=>dispatch.register(registration),/unloaded/);
});

void test('ambiguous creation handlers do not open either form and async failures propagate', async () => {
	const dispatch=new module.exports.ChildCreation();let count=0;
	dispatch.register({id:'a',matches:()=>true,open:()=>{count++;}});
	const remove=dispatch.register({id:'b',matches:()=>true,open:()=>{count++;}});
	await assert.rejects(dispatch.tryOpen('learning/dl'),/More than one/);assert.equal(count,0);
	remove();assert.equal(await dispatch.tryOpen('learning/dl'),true);assert.equal(count,1);
	dispatch.dispose();
});
