import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/canonical.js';
import { DEFAULT_POLICY } from '../src/domain/policy.js';
import { evaluatePower, type Adapter, type GeneratorSupply, type PowerRequirement, type SiteSupply } from '../src/domain/power.js';

const req: PowerRequirement = { voltageMin: 208, voltageMax: 230, phase: 'SINGLE', amperage: 30, inletConnector: 'NEMA_L14_30', shorePowerCapable: true, status: 'VERIFIED' };
const noSite: SiteSupply = { availability: 'UNAVAILABLE', voltage: null, phase: null, amperage: null, connector: null, status: 'VERIFIED', cableRunFt: 40, cableStatus: 'VERIFIED' };
const gen: GeneratorSupply = { present: true, continuousKw: 12, fuelNotes: '24h', voltage: 230, phase: 'SINGLE', amperage: 50, connector: 'CS6365', gateVerified: true, gateFailed: false };
const adapter = (o: Partial<Adapter> = {}): Adapter => ({ id: 'a1', fromConnector: 'CS6365', toConnector: 'NEMA_L14_30', ratedAmperage: 30, ratedVoltage: 250, approved: true, ...o });
const codes = (r: { reasons: { code: string }[] }) => r.reasons.map((x) => x.code);

describe('power matching', () => {
  it('matches through an approved, adequately rated adapter', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, gen, [adapter()]);
    assert.equal(r.result, 'MATCH');
    assert.equal(r.source, 'GENERATOR');
    assert.equal(r.adapterUsed, 'a1');
  });

  it('an unapproved adapter leaves the match UNCONFIRMED (not GREEN, not RED)', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, gen, [adapter({ approved: false })]);
    assert.equal(r.result, 'UNCONFIRMED');
    assert.ok(codes(r).includes('GENERATOR_OUTPUT_UNCONFIRMED'));
  });

  it('no adapter between different connectors is a known mismatch', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, gen, []);
    assert.equal(r.result, 'MISMATCH');
    assert.ok(codes(r).includes('GENERATOR_CONNECTOR_MISMATCH_NO_APPROVED_ADAPTER'));
  });

  it('an approved but under-rated adapter is a mismatch', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, gen, [adapter({ ratedAmperage: 20 })]);
    assert.equal(r.result, 'MISMATCH');
  });

  it('a matching connector name does not override a voltage or phase mismatch', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, { ...gen, connector: 'NEMA_L14_30', amperage: 30, voltage: 120 }, []);
    assert.equal(r.result, 'MISMATCH');
    assert.ok(codes(r).includes('GENERATOR_VOLTAGE_MISMATCH'));
  });

  it('unknown values are UNCONFIRMED rather than assumed compatible', () => {
    const r = evaluatePower(DEFAULT_POLICY, req, noSite, { ...gen, voltage: null }, [adapter()]);
    assert.equal(r.result, 'UNCONFIRMED');
    const r2 = evaluatePower(DEFAULT_POLICY, { ...req, amperage: null }, noSite, gen, [adapter()]);
    assert.equal(r2.result, 'UNCONFIRMED');
    assert.ok(codes(r2).includes('POWER_REQUIREMENT_UNKNOWN'));
  });

  it('verified matching site power needs no generator; unverified site power does', () => {
    const site: SiteSupply = { availability: 'AVAILABLE', voltage: 208, phase: 'SINGLE', amperage: 30, connector: 'NEMA_L14_30', status: 'VERIFIED', cableRunFt: 50, cableStatus: 'VERIFIED' };
    const none: GeneratorSupply = { ...gen, present: false };
    assert.equal(evaluatePower(DEFAULT_POLICY, req, site, none, []).result, 'MATCH');
    const unverified = evaluatePower(DEFAULT_POLICY, req, { ...site, status: 'PENDING' }, none, []);
    assert.equal(unverified.result, 'UNCONFIRMED');
    assert.ok(codes(unverified).includes('GENERATOR_REQUIRED_NOT_ASSIGNED'));
    const longRun = evaluatePower(DEFAULT_POLICY, req, { ...site, cableRunFt: 250 }, none, []);
    assert.equal(longRun.result, 'MISMATCH');
    assert.ok(codes(longRun).includes('SITE_CABLE_RUN_EXCEEDS_POLICY'));
  });

  it('a power requirement outside the acceptable configurations is RED', () => {
    const r = evaluatePower(DEFAULT_POLICY, { ...req, voltageMin: 110, voltageMax: 120 }, noSite, gen, [adapter()]);
    assert.ok(codes(r).includes('POWER_CONFIG_NOT_PERMITTED'));
    assert.equal(r.result, 'MISMATCH');
  });
});

describe('canonical JSON', () => {
  it('sorts keys recursively and omits undefined members', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
    assert.throws(() => canonicalJson({ x: Number.NaN }));
  });
});
