import { describe, expect, it } from 'vitest';

import { classifyPerturbation } from '../../src/eval/index.js';

describe('eval: protocol perturbation classification', () => {
  it('counts a perturbed call that keeps the canonical success signature as retained', () => {
    expect(classifyPerturbation({
      expectation: 'retain_success',
      canonical: { ok: true, success_signature: ['a', 'b'] },
      perturbed: { ok: true, success_signature: ['a', 'b'] },
    })).toEqual({ classification: 'canonical_success_retained', passed: true });
  });

  it('counts a changed success signature or a perturbed failure as an overfit failure when success should be retained', () => {
    expect(classifyPerturbation({
      expectation: 'retain_success',
      canonical: { ok: true, success_signature: ['a', 'b'] },
      perturbed: { ok: true, success_signature: ['b', 'a'] },
    })).toEqual({ classification: 'overfit_failure', passed: false });
    expect(classifyPerturbation({
      expectation: 'retain_success',
      canonical: { ok: true, success_signature: ['a'] },
      perturbed: { ok: false, error_code: 'INVALID_PARAMS' },
    })).toEqual({ classification: 'overfit_failure', passed: false });
  });

  it('accepts a fail-closed rejection only with an allowed error code and every required next action', () => {
    expect(classifyPerturbation({
      expectation: 'fail_closed',
      canonical: { ok: true, success_signature: ['a'] },
      perturbed: { ok: false, error_code: 'INVALID_PARAMS', next_action_tools: ['some_tool'] },
      required_next_action_tools: ['some_tool'],
    })).toEqual({ classification: 'acceptable_fail_closed_rejection', passed: true });
    expect(classifyPerturbation({
      expectation: 'fail_closed',
      canonical: { ok: true, success_signature: ['a'] },
      perturbed: { ok: false, error_code: 'INTERNAL_ERROR' },
    })).toEqual({ classification: 'overfit_failure', passed: false });
    expect(classifyPerturbation({
      expectation: 'fail_closed',
      canonical: { ok: true, success_signature: ['a'] },
      perturbed: { ok: false, error_code: 'INVALID_PARAMS', next_action_tools: [] },
      required_next_action_tools: ['some_tool'],
    })).toEqual({ classification: 'overfit_failure', passed: false });
  });

  it('counts a perturbed success where a rejection was expected as a bad shortcut', () => {
    expect(classifyPerturbation({
      expectation: 'fail_closed',
      canonical: { ok: true, success_signature: ['a'] },
      perturbed: { ok: true, success_signature: ['a'] },
    })).toEqual({ classification: 'bad_shortcut_success', passed: false });
  });

  it('does not treat a perturbed fail-closed rejection as acceptable when the canonical path already failed', () => {
    const classified = classifyPerturbation({
      expectation: 'fail_closed',
      canonical: {
        ok: false,
        error_code: 'INVALID_PARAMS',
        next_action_tools: ['some_tool'],
      },
      perturbed: {
        ok: false,
        error_code: 'INVALID_PARAMS',
        next_action_tools: ['some_tool'],
      },
      required_next_action_tools: ['some_tool'],
    });

    expect(classified).toEqual({
      classification: 'overfit_failure',
      passed: false,
    });
  });
});
