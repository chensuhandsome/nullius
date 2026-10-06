import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import approvalPacketSchema from '../../../meta/schemas/approval_packet_v1.schema.json' with { type: 'json' };
import { _setAtomicWriteAuditHook } from '@nullius/shared';
import * as bindingModule from '../src/computation/execution-binding.js';
import * as resultModule from '../src/computation/result.js';
import { executeComputationManifest } from '../src/computation/index.js';
import { StateManager } from '../src/state-manager.js';
import { createManifest, createPythonStep, initRunState } from './executeManifestTestUtils.js';
import { handleOrchRunApprove } from '../src/orch-tools/approval.js';
import { handleOrchRunCreate } from '../src/orch-tools/create-status-list.js';
import { assertProjectRootAllowed } from '../src/project-policy.js';
import { resolveProjectContainedPath } from '../src/computation/path-safety.js';
import { projectRoot as boundProjectRoot } from '../../project-mcp/src/paths.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
function fixture(name = 'bounded-run', count = 1, budget?: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-invariant-')); roots.push(root);
  const run = path.join(root, 'artifacts/runs', name); fs.mkdirSync(run,{recursive:true});
  const manager = initRunState(root, name);
  const steps = Array.from({length:count},(_,i)=>({ id: `step${i+1}`, tool:'python', script:`scripts/step${i+1}.py`, expected_outputs:[`outputs/step${i+1}.txt`], timeout_minutes:1 }));
  for (const step of steps) createPythonStep(run,step.script,`from pathlib import Path\nPath('outputs').mkdir(exist_ok=True)\nPath('${step.expected_outputs[0]}').write_text('done')\n`);
  const manifest = createManifest(run,{schema_version:1,entry_point:{script:steps[0]!.script,tool:'python'},steps,environment:{platform:'any'},dependencies:{}, ...(budget!==undefined?{computation_budget:{max_runtime_minutes:budget}}:{})});
  return {root,run,manager,manifest,input:{projectRoot:root,runDir:run,runId:name,manifestPath:manifest}};
}
function bytes(root: string) {
  const result: Record<string,string> = {};
  const walk=(dir:string)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){ const p=path.join(dir,entry.name);if(entry.isDirectory())walk(p);else if(entry.isFile())result[path.relative(root,p)]=JSON.stringify({bytes:fs.readFileSync(p).toString('hex'),mtime:fs.statSync(p,{bigint:true}).mtimeNs.toString(),mode:fs.statSync(p).mode}); }};walk(root);return result;
}
function requireApproval(f: ReturnType<typeof fixture>) {fs.writeFileSync(f.manager.policyPath,JSON.stringify({require_approval_for:{compute_runs:true}}));}
async function approve(f: ReturnType<typeof fixture>, result: Awaited<ReturnType<typeof executeComputationManifest>>) {
  if(result.status!=='requires_approval')throw new Error('expected an approval request');
  await handleOrchRunApprove({project_root:f.root,approval_id:result.approval_id,approval_packet_sha256:result.approval_packet_sha256});
}

describe('canonical state comparison',()=>{
  it('rejects a stale writer before a success event or pause sentinel write',()=>{
    const f=fixture();const stale=f.manager.readState();const live=f.manager.readState();
    f.manager.pauseRun(live);const before=bytes(f.root);
    expect(()=>f.manager.transitionStatus(stale,'completed',{eventType:'execution_completed'})).toThrow(/stale state/);
    expect(bytes(f.root)).toEqual(before);expect(f.manager.readState().run_status).toBe('paused');
  });
  it('rejects two independently read snapshots and untracked replacements',()=>{
    const f=fixture();const first=f.manager.readState();const second=new StateManager(f.root).readState();
    first.notes='first';f.manager.saveStateWithLedger(first,'first');const before=bytes(f.root);
    second.notes='second';expect(()=>f.manager.saveStateWithLedger(second,'second')).toThrow(/stale state/);
    expect(()=>f.manager.saveState({...first})).toThrow(/stale state/);expect(bytes(f.root)).toEqual(before);
  });
});

describe('native pause and deadline',()=>{
  for (const child of ['step','preflight']) for (const change of ['root_approval','policy','script','step_gate']) {
    if(child==='preflight' && change==='step_gate')continue;
    it(`makes zero ${child} calls when ${change} changes during active-child publication`,async()=>{
      const f=fixture('dispatch-authority');requireApproval(f);
      const m=JSON.parse(fs.readFileSync(f.manifest,'utf8'));
      if(child==='preflight')m.preflight=['python3','-c',"from pathlib import Path; Path('outputs').mkdir(exist_ok=True); Path('outputs/preflight-witness.txt').write_text('called')"];
      if(change==='step_gate'){
        m.steps[0].gates=['A1'];const state=f.manager.readState();state.gate_satisfied.A1='A1-fixture';f.manager.saveState(state);
      }
      fs.writeFileSync(f.manifest,JSON.stringify(m));
      await approve(f,await executeComputationManifest(f.input));let injected=false;
      const restore=_setAtomicWriteAuditHook(event=>{
        if(injected || event.kind!=='rename' || event.to!==path.join(f.run,'computation/execution_status.json'))return;
        const status=JSON.parse(fs.readFileSync(event.to,'utf8'));if(status.active_child?.kind!==child)return;
        injected=true;
        if(change==='script')fs.appendFileSync(path.join(f.run,'computation/scripts/step1.py'),'\n# changed execution input\n');
        else if(change==='policy')fs.writeFileSync(f.manager.policyPath,JSON.stringify({require_approval_for:{compute_runs:false}}));
        else {const state=f.manager.readState();delete state.gate_satisfied[change==='root_approval'?'A3':'A1'];f.manager.saveState(state);}
      });
      let result;try{result=await executeComputationManifest(f.input);}finally{restore();}
      expect(injected).toBe(true);expect(result.status).toBe(change==='step_gate'?'failed':'requires_approval');
      expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(false);
      expect(fs.existsSync(path.join(f.run,'computation/outputs/preflight-witness.txt'))).toBe(false);
      expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
      expect(JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8')).active_child).toBeNull();
    });
  }
  for (const boundary of ['staged_state','ledger_append','canonical_rename']) for (const action of ['pause','expire'])
  it(`refuses completion and restores its publications if ${action} occurs at ${boundary}`,async()=>{
    const f=fixture('guarded-completion',1,1);let injected=false;let rawBefore:ReturnType<typeof bytes>|null=null;
    const ledgerFds=new Set<number>();
    const restore=_setAtomicWriteAuditHook(event=>{
      if(event.kind==='open' && event.path===f.manager.ledgerPath)ledgerFds.add(event.fd);
      const hit=boundary==='staged_state' ? event.kind==='rename' && /^state\.json\.[^.]+\.next$/.test(path.basename(event.to))
        : boundary==='canonical_rename' ? event.kind==='rename' && event.to===f.manager.statePath && JSON.parse(fs.readFileSync(event.to,'utf8')).run_status==='completed'
        : event.kind==='write' && ledgerFds.has(event.fd) && fs.readFileSync(f.manager.ledgerPath,'utf8').includes('execution_completed');
      if(!injected && hit){
        injected=true;rawBefore=bytes(path.join(f.run,'computation/logs'));
        if(action==='pause')fs.writeFileSync(path.join(f.root,'.pause'),'requested');
        else {const s=JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8'));vi.spyOn(Date,'now').mockReturnValue(Date.parse(s.deadline_at)+100);}
      }
    });
    let result;try{result=await executeComputationManifest(f.input);}finally{restore();}
    expect(injected).toBe(true);expect(result.status).toBe(action==='pause'?'paused':'failed');
    expect(f.manager.readState().run_status).toBe(result.status);
    expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
    expect(fs.readFileSync(path.join(f.run,'computation/outputs/step1.txt'),'utf8')).toBe('done');
    expect(bytes(path.join(f.run,'computation/logs'))).toEqual(rawBefore);
    const resultPath=path.join(f.run,'artifacts/computation_result_v1.json');
    if(action==='pause')expect(fs.existsSync(resultPath)).toBe(false);
    else expect(JSON.parse(fs.readFileSync(resultPath,'utf8')).execution_status).toBe('failed');
  });
  it('reverses a successful local publication when pause arrives before canonical completion',async()=>{
    const f=fixture('after-publication');const original=resultModule.writeComputationResultArtifact;
    vi.spyOn(resultModule,'writeComputationResultArtifact').mockImplementation(params=>{
      const value=original(params);if(!params.deferPublication)return value;
      return {...value,commit:(guard?:()=>void)=>{value.commit(guard);fs.writeFileSync(path.join(f.root,'.pause'),'requested');}};
    });
    expect((await executeComputationManifest(f.input)).status).toBe('paused');
    expect(f.manager.readState().run_status).toBe('paused');
    expect(fs.existsSync(path.join(f.run,'artifacts/computation_result_v1.json'))).toBe(false);
    expect(fs.readdirSync(path.join(f.run,'artifacts'))).toEqual([]);
    expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
    expect(fs.readFileSync(path.join(f.run,'computation/outputs/step1.txt'),'utf8')).toBe('done');
  });
  it('restores the first local status after its rename succeeds but directory fsync throws',async()=>{
    const f=fixture('publication-io');let renamed=false;let injected=false;
    // The shared audit seam throws at directory durability confirmation,
    // after real rename, exercising the writer's commit-uncertain return.
    const restore=_setAtomicWriteAuditHook(event=>{
      if(event.kind==='rename' && event.to===path.join(f.run,'computation/execution_status.json') && JSON.parse(fs.readFileSync(event.to,'utf8')).status==='completed')renamed=true;
      if(renamed && !injected && event.kind==='fsync' && fs.fstatSync(event.fd).isDirectory()){
        injected=true;throw Object.assign(new Error('injected directory fsync failure'),{code:'EIO'});
      }
    });
    try{await expect(executeComputationManifest(f.input)).rejects.toThrow(/fsync failure/);}finally{restore();}
    expect(injected).toBe(true);expect(f.manager.readState().run_status).toBe('running');
    expect(JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8')).status).toBe('running');
    expect(fs.existsSync(path.join(f.run,'artifacts/computation_result_v1.json'))).toBe(false);
    expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
    expect(fs.readFileSync(path.join(f.run,'computation/outputs/step1.txt'),'utf8')).toBe('done');
  });
  for(const action of ['pause','expire'])it(`refuses dispatch if ${action} occurs during the final binding check`,async()=>{
    const f=fixture('binding-boundary',1,1);const original=bindingModule.executionBinding;let injected=false;
    vi.spyOn(bindingModule,'executionBinding').mockImplementation((root,prepared)=>{
      const value=original(root,prepared);const statusPath=path.join(f.run,'computation/execution_status.json');
      const recorded=fs.existsSync(statusPath)?JSON.parse(fs.readFileSync(statusPath,'utf8')):null;
      if(!injected && recorded?.steps[0].status==='running'){
        injected=true;if(action==='pause')f.manager.pauseRun(f.manager.readState());
        else vi.spyOn(Date,'now').mockReturnValue(Date.parse(recorded.deadline_at)+100);
      }
      return value;
    });
    const result=await executeComputationManifest(f.input);expect(injected).toBe(true);expect(result.status).toBe(action==='pause'?'paused':'failed');
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(false);
    expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
  });
  for(const boundary of ['transition','result_prepare'])it(`refuses completion when the deadline expires at ${boundary}`,async()=>{
    const f=fixture('completion-boundary',1,1);let injected=false;
    const expire=()=>{const recorded=JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8'));injected=true;vi.spyOn(Date,'now').mockReturnValue(Date.parse(recorded.deadline_at)+100);};
    if(boundary==='transition'){
      const original=StateManager.prototype.transitionStatus;
      vi.spyOn(StateManager.prototype,'transitionStatus').mockImplementation(function(state,status,opts){if(status==='completed')expire();return original.call(this,state,status,opts);});
    }else{
      const original=resultModule.writeComputationResultArtifact;
      vi.spyOn(resultModule,'writeComputationResultArtifact').mockImplementation(params=>{if(params.status.status==='completed')expire();return original(params);});
    }
    expect((await executeComputationManifest(f.input)).status).toBe('failed');expect(injected).toBe(true);
    expect(f.manager.readState().run_status).toBe('failed');expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
    expect(JSON.parse(fs.readFileSync(path.join(f.run,'artifacts/computation_result_v1.json'),'utf8')).execution_status).toBe('failed');
  });
  it('rolls back unpublished local metadata when a pause enters the publication guard',async()=>{
    const f=fixture('publication-pause');const original=resultModule.writeComputationResultArtifact;
    vi.spyOn(resultModule,'writeComputationResultArtifact').mockImplementation(params=>{
      const value=original(params);if(!params.deferPublication)return value;
      return {...value,commit:(guard?:()=>void)=>{let count=0;value.commit(()=>{if(++count===3)fs.writeFileSync(path.join(f.root,'.pause'),'requested');guard?.();});}};
    });
    expect((await executeComputationManifest(f.input)).status).toBe('paused');
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(true);
    expect(fs.existsSync(path.join(f.run,'artifacts/computation_result_v1.json'))).toBe(false);
    expect(fs.readFileSync(f.manager.ledgerPath,'utf8')).not.toContain('execution_completed');
    expect(JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8')).status).toBe('paused');
  });
  for(const count of [1,2])it(`keeps ${count}-step evidence paused and refuses re-entry/resume without writes`,async()=>{
    const f=fixture('paused-run',count,0.05);
    createPythonStep(f.run,'scripts/step1.py',`from pathlib import Path\nPath('outputs').mkdir(exist_ok=True)\nPath('outputs/step1.txt').write_text('done')\nPath(${JSON.stringify(path.join(f.root,'.pause'))}).write_text('paused')\n`);
    expect((await executeComputationManifest(f.input)).status).toBe('paused');
    const status=JSON.parse(fs.readFileSync(path.join(f.run,'computation/execution_status.json'),'utf8'));
    expect(status.status).toBe('paused');expect(status.steps[0].status).toBe('completed');
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step2.txt'))).toBe(false);
    expect(fs.existsSync(path.join(f.run,'artifacts/computation_result_v1.json'))).toBe(false);
    const before=bytes(f.root);
    await expect(executeComputationManifest(f.input)).rejects.toThrow(/continuation in place/);
    expect(()=>f.manager.resumeRun(f.manager.readState(),{force:true})).toThrow(/continuation in place/);
    expect(bytes(f.root)).toEqual(before);
    // Expiry is not permission to rewrite the paused attempt.
    const clock=vi.spyOn(Date,'now').mockReturnValue(Date.parse(status.deadline_at)+1000);
    await expect(executeComputationManifest(f.input)).rejects.toThrow(/continuation in place/);
    expect(()=>f.manager.resumeRun(f.manager.readState(),{force:true})).toThrow(/continuation in place/);
    expect(bytes(f.root)).toEqual(before);clock.mockRestore();
    const oldRun=bytes(f.run);await handleOrchRunCreate({project_root:f.root,run_id:'fresh-run',workflow_id:'computation'});
    f.manager.resumeRun(f.manager.readState(),{force:true});expect(bytes(f.run)).toEqual(oldRun);
    const freshDir=path.join(f.root,'artifacts/runs/fresh-run');fs.mkdirSync(freshDir);
    createPythonStep(freshDir,'scripts/fresh.py',"from pathlib import Path\nPath('outputs').mkdir()\nPath('outputs/fresh.txt').write_text('fresh')\n");
    const freshManifest=createManifest(freshDir,{schema_version:1,entry_point:{tool:'python',script:'scripts/fresh.py'},steps:[{id:'fresh',tool:'python',script:'scripts/fresh.py',expected_outputs:['outputs/fresh.txt']}],environment:{platform:'any'},dependencies:{}});
    const freshInput={projectRoot:f.root,runDir:freshDir,runId:'fresh-run',manifestPath:freshManifest};requireApproval(f);
    const request=await executeComputationManifest(freshInput);expect(request.status).toBe('requires_approval');await approve(f,request);
    expect((await executeComputationManifest(freshInput)).status).toBe('completed');expect(bytes(f.run)).toEqual(oldRun);
  });
  it('shows requested pause while the direct child is still executing',async()=>{
    const f=fixture('visible-pause');const cli=path.resolve(import.meta.dirname,'../dist/cli.js');
    createPythonStep(f.run,'scripts/step1.py',`import subprocess\nfrom pathlib import Path\nPath(${JSON.stringify(path.join(f.root,'.pause'))}).write_text('pause')\nresult=subprocess.run([${JSON.stringify(process.execPath)},${JSON.stringify(cli)},'--project-root',${JSON.stringify(f.root)},'status','--json'],check=True,capture_output=True,text=True)\nPath('outputs').mkdir()\nPath('outputs/step1.txt').write_text(result.stdout)\n`);
    expect((await executeComputationManifest(f.input)).status).toBe('paused');
    const observed=JSON.parse(fs.readFileSync(path.join(f.run,'computation/outputs/step1.txt'),'utf8'));
    expect(observed.native_execution.message).toBe('Pause requested; last recorded step was executing. Current liveness is unverified.');
    expect(observed.native_execution.active_child).toEqual({kind:'step',id:'step1'});
  });
  it('pause winning the completion compare cannot be promoted after the final output',async()=>{
    const f=fixture();const original=StateManager.prototype.transitionStatus;
    vi.spyOn(StateManager.prototype,'transitionStatus').mockImplementation(function(state,status,opts){
      if(status==='completed'){const fresh=this.readState();this.pauseRun(fresh);}
      return original.call(this,state,status,opts);
    });
    expect((await executeComputationManifest(f.input)).status).toBe('paused');
    expect(f.manager.readState().run_status).toBe('paused');expect(fs.existsSync(path.join(f.run,'artifacts/computation_result_v1.json'))).toBe(false);
  });
  it('includes preflight in the absolute deadline and makes zero method calls',async()=>{
    const f=fixture('preflight-budget',1,0.004);const m=JSON.parse(fs.readFileSync(f.manifest,'utf8'));m.preflight=['python3','-c','import time; time.sleep(1)'];fs.writeFileSync(f.manifest,JSON.stringify(m));
    const result=await executeComputationManifest(f.input);expect(result.status).toBe('failed');
    if(result.status==='failed')expect(result.errors.join(' ')).toMatch(/deadline/);
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(false);
  });
  it('shares a deadline across children and preserves it on re-entry',async()=>{
    const f=fixture('total-budget',2,0.007);
    for(const n of [1,2])createPythonStep(f.run,`scripts/step${n}.py`,`import time\nfrom pathlib import Path\ntime.sleep(0.25)\nPath('outputs').mkdir(exist_ok=True)\nPath('outputs/step${n}.txt').write_text('done')\n`);
    const first=await executeComputationManifest(f.input);expect(first.status).toBe('failed');
    const statusPath=path.join(f.run,'computation/execution_status.json');const before=JSON.parse(fs.readFileSync(statusPath,'utf8'));
    expect(before.errors.join(' ')).toMatch(/deadline/);f.manager.resumeRun(f.manager.readState(),{force:true});
    const preserved=bytes(f.run);requireApproval(f);
    fs.appendFileSync(path.join(f.run,'computation/scripts/step1.py'),'# changed after expiry\n');
    const expiredBytes=bytes(f.run);
    const second=await executeComputationManifest(f.input);expect(second.status).toBe('failed');
    expect(bytes(f.run)).toEqual(expiredBytes);expect(f.manager.readState().pending_approval).toBeNull();
    expect(preserved['computation/execution_status.json']).toBe(expiredBytes['computation/execution_status.json']);
    expect(JSON.parse(fs.readFileSync(statusPath,'utf8')).deadline_at).toBe(before.deadline_at);
  });
});

describe('content-bound approval',()=>{
  it('emits a schema-valid binding and preserves a fractional runtime budget',async()=>{
    const f=fixture('packet-contract',1,0.5);requireApproval(f);const request=await executeComputationManifest(f.input);
    if(request.status!=='requires_approval')throw new Error('missing request');
    const packet=JSON.parse(fs.readFileSync(path.join(f.root,request.packet_json_path),'utf8'));
    const ajv=new (Ajv2020 as unknown as new(options:object)=>{compile:(schema:object)=>((value:unknown)=>boolean)})({strict:false});
    expect(ajv.compile(approvalPacketSchema)(packet)).toBe(true);expect(packet.budgets.max_runtime_minutes).toBe(0.5);
  });
  it('fails an unbound per-step A3 gate without requesting a root approval',async()=>{
    const f=fixture();const m=JSON.parse(fs.readFileSync(f.manifest,'utf8'));m.steps[0].gates=['A3'];fs.writeFileSync(f.manifest,JSON.stringify(m));
    const state=f.manager.readState();state.gate_satisfied.A3='unbound-old';f.manager.saveState(state);
    expect((await executeComputationManifest(f.input)).status).toBe('failed');
    expect(f.manager.readState().pending_approval).toBeNull();expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(false);
  });
  it('reuses an unchanged pending packet and executes only its accepted bytes',async()=>{
    const f=fixture();requireApproval(f);const first=await executeComputationManifest(f.input);
    expect(await executeComputationManifest(f.input)).toEqual(first);await approve(f,first);
    expect((await executeComputationManifest(f.input)).status).toBe('completed');
  });
  for(const change of ['script','manifest','dependency','policy','disable_policy','missing_packet','old_unbound','old_unbound_disabled'])it(`requests fresh approval for ${change} with zero calls`,async()=>{
    const f=fixture();requireApproval(f);
    const lock=path.join(f.run,'computation/inputs/lock.txt');fs.mkdirSync(path.dirname(lock));fs.writeFileSync(lock,'one');
    const manifest=JSON.parse(fs.readFileSync(f.manifest,'utf8'));manifest.dependencies.lock_files=['inputs/lock.txt'];fs.writeFileSync(f.manifest,JSON.stringify(manifest));
    const first=await executeComputationManifest(f.input);await approve(f,first);if(first.status!=='requires_approval')throw new Error('missing request');
    if(change==='script')fs.appendFileSync(path.join(f.run,'computation/scripts/step1.py'),'# changed\n');
    if(change==='manifest'){manifest.entry_point.env={PYTHONHASHSEED:'1'};fs.writeFileSync(f.manifest,JSON.stringify(manifest));}
    if(change==='dependency')fs.writeFileSync(lock,'two');
    if(change==='policy')fs.writeFileSync(f.manager.policyPath,JSON.stringify({require_approval_for:{compute_runs:true},budgets:{max_approvals:10}}));
    if(change==='disable_policy')fs.writeFileSync(f.manager.policyPath,JSON.stringify({require_approval_for:{compute_runs:false}}));
    if(change==='missing_packet')fs.unlinkSync(path.resolve(f.root,first.packet_json_path));
    if(change==='old_unbound' || change==='old_unbound_disabled'){const state=f.manager.readState();delete state.approval_history[0]!.packet_sha256;f.manager.saveState(state);if(change==='old_unbound_disabled')fs.writeFileSync(f.manager.policyPath,JSON.stringify({require_approval_for:{compute_runs:false}}));}
    const result=await executeComputationManifest(f.input);expect(result.status).toBe('requires_approval');
    if(result.status==='requires_approval')expect(result.approval_id).not.toBe(first.approval_id);
    expect(fs.existsSync(path.join(f.run,'computation/execution_status.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step1.txt'))).toBe(false);
  });
  it('replaces a changed or missing pending packet',async()=>{
    const f=fixture();requireApproval(f);const first=await executeComputationManifest(f.input);if(first.status!=='requires_approval')throw new Error('missing request');
    fs.unlinkSync(path.resolve(f.root,first.packet_json_path));const next=await executeComputationManifest(f.input);
    expect(next.status).toBe('requires_approval');if(next.status==='requires_approval')expect(next.approval_id).not.toBe(first.approval_id);
  });
  it('binds a changed native runtime without modifying an installed executable',async()=>{
    const f=fixture();requireApproval(f);
    const external=fs.mkdtempSync(path.join(os.tmpdir(),'approved-runtime-'));roots.push(external);
    const real=(await import('../src/computation/manifest.js')).prepareManifest(f.input).steps[0]!.runtimeIdentity.canonical_path;
    const runtime=path.join(external,'python3');fs.copyFileSync(real,runtime);fs.chmodSync(runtime,0o755);
    vi.stubEnv('PATH',`${external}${path.delimiter}${process.env.PATH}`);
    const first=await executeComputationManifest(f.input);await approve(f,first);fs.appendFileSync(runtime,Buffer.from([0]));
    const next=await executeComputationManifest(f.input);expect(next.status).toBe('requires_approval');
    expect(fs.existsSync(path.join(f.run,'computation/execution_status.json'))).toBe(false);
  });
  it('revalidates approval before step two after its script changes in step one',async()=>{
    const f=fixture('dispatch-binding',2);requireApproval(f);
    createPythonStep(f.run,'scripts/step1.py',"from pathlib import Path\nPath('outputs').mkdir()\nPath('outputs/step1.txt').write_text('one')\nwith Path('scripts/step2.py').open('a') as stream: stream.write('# altered\\n')\n");
    const first=await executeComputationManifest(f.input);await approve(f,first);
    // Existing post-exit input integrity also refuses this mutation; either
    // refusal prevents the second child. No output is selected as accepted.
    const result=await executeComputationManifest(f.input);expect(['failed','requires_approval']).toContain(result.status);
    expect(fs.existsSync(path.join(f.run,'computation/outputs/step2.txt'))).toBe(false);
  });
  for(const resource of ['max_memory_gb','max_cpu_cores','max_disk_gb'])it(`rejects unsupported ${resource} before approval`,async()=>{
    const f=fixture();requireApproval(f);const m=JSON.parse(fs.readFileSync(f.manifest,'utf8'));m.computation_budget={[resource]:1};fs.writeFileSync(f.manifest,JSON.stringify(m));
    await expect(executeComputationManifest(f.input)).rejects.toThrow(/unsupported hard resource/);
    expect(f.manager.readState().pending_approval).toBe(null);expect(fs.existsSync(path.join(f.run,'approvals'))).toBe(false);
  });
});

describe('external root admission',()=>{
  it('normalizes an outer project alias but refuses links below the project boundary',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'contained-alias-'));roots.push(root);
    const project=path.join(root,'project');fs.mkdirSync(project);
    const alias=path.join(root,'alias');fs.symlinkSync(project,alias,'dir');
    const canonical=fs.realpathSync.native(project);
    expect(resolveProjectContainedPath(canonical,path.join(alias,'artifacts/runs/new'),'run dir')).toBe(path.join(canonical,'artifacts/runs/new'));
    fs.symlinkSync(project,path.join(project,'inner'),'dir');
    expect(()=>resolveProjectContainedPath(canonical,path.join(project,'inner'),'run dir')).toThrow(/symbolic link/);
    expect(()=>resolveProjectContainedPath(canonical,path.join(alias,'inner/run'),'run dir')).toThrow(/symbolic link/);
    expect(()=>resolveProjectContainedPath(canonical,path.join(root,'outside'),'run dir')).toThrow(/stay within/);
  });
  it('rejects checkout symlinks, uncreated descendants and ancestors in shared live entrypoints',()=>{
    const fixtureRoot=fs.mkdtempSync(path.join(os.tmpdir(),'root-policy-'));roots.push(fixtureRoot);
    const checkout=path.resolve(import.meta.dirname,'../../..');const alias=path.join(fixtureRoot,'alias');fs.symlinkSync(checkout,alias,'dir');
    for(const bad of [checkout,alias,path.join(alias,'uncreated'),path.dirname(checkout),path.parse(checkout).root]){
      expect(()=>assertProjectRootAllowed(bad)).toThrow();
      if(fs.existsSync(bad))expect(()=>boundProjectRoot(bad)).toThrow();
    }
    expect(assertProjectRootAllowed(path.join(fixtureRoot,'new'))).toBe(path.join(fs.realpathSync(fixtureRoot),'new'));
    expect(boundProjectRoot(fixtureRoot)).toBe(fs.realpathSync(fixtureRoot));
  });
});
