import { describe, expect, it } from 'vitest';
import { isEffectiveAt, SpecError, windowContains } from '../src/index.js';
import type { CivilCalendar } from '../src/index.js';
import { fixedCalendar, specError, transitionCalendar } from './helpers.js';

const open = (from: string, until: string | null = null, timeZone?: string) =>
  timeZone === undefined
    ? { effectiveFrom: from, effectiveUntil: until }
    : { effectiveFrom: from, effectiveUntil: until, timeZone };

/** A calendar that fails the test when it is called. */
const noCalendar: CivilCalendar = {
  toCivilDate: () => {
    throw new Error('toCivilDate must not be called');
  },
  startOfDay: () => {
    throw new Error('startOfDay must not be called');
  },
};

describe('windowContains: civil bounds', () => {
  const rule = open('2026-01-01');

  it('compares a civil date with civil bounds, without the calendar', () => {
    expect(windowContains(rule, '2025-12-31', 'UTC', noCalendar)).toBe(false);
    expect(windowContains(rule, '2026-01-01', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '9999-12-31', 'Europe/Paris', noCalendar)).toBe(true);
  });

  it('turns an instant into the civil date of the time zone', () => {
    expect(windowContains(rule, '2025-12-31T23:30:00.000Z', 'Europe/Paris', fixedCalendar)).toBe(
      true,
    );
    expect(windowContains(rule, '2025-12-31T23:30:00.000Z', 'UTC', fixedCalendar)).toBe(false);
    expect(windowContains(rule, '2025-12-31T13:00:00.000Z', 'Pacific/Noumea', fixedCalendar)).toBe(
      true,
    );
    expect(windowContains(rule, '2025-12-31T12:59:59.999Z', 'Pacific/Noumea', fixedCalendar)).toBe(
      false,
    );
  });

  it('excludes until, as a civil date and through an instant', () => {
    const year = open('2025-01-01', '2026-01-01');
    expect(windowContains(year, '2025-12-31', 'UTC', fixedCalendar)).toBe(true);
    expect(windowContains(year, '2026-01-01', 'UTC', fixedCalendar)).toBe(false);
    expect(windowContains(year, '2025-12-31T22:59:59.999Z', 'Europe/Paris', fixedCalendar)).toBe(
      true,
    );
    expect(windowContains(year, '2025-12-31T23:00:00.000Z', 'Europe/Paris', fixedCalendar)).toBe(
      false,
    );
  });

  it("the rule's time zone wins over the one passed", () => {
    const paris = open('2026-01-01', null, 'Europe/Paris');
    expect(windowContains(paris, '2025-12-31T23:30:00.000Z', 'UTC', fixedCalendar)).toBe(true);
    const utc = open('2026-01-01', null, 'UTC');
    expect(windowContains(utc, '2025-12-31T23:30:00.000Z', 'Europe/Paris', fixedCalendar)).toBe(
      false,
    );
  });

  it("writes the rule's '+00:00' as UTC before calling the calendar", () => {
    const zones: string[] = [];
    const recording: CivilCalendar = {
      toCivilDate: (at, zone) => {
        zones.push(zone);
        return fixedCalendar.toCivilDate(at, zone);
      },
      startOfDay: (day, zone) => fixedCalendar.startOfDay(day, zone),
    };
    windowContains(
      open('2026-01-01', null, '+00:00'),
      '2026-01-01T00:00:00.000Z',
      'UTC',
      recording,
    );
    windowContains(open('2026-01-01'), '2026-01-01T00:00:00.000Z', '-00:00', recording);
    expect(zones).toEqual(['UTC', 'UTC']);
  });

  it('on a day without midnight, the civil day starts at its first instant', () => {
    const rule = open('2026-09-06', null, 'America/Santiago');
    expect(windowContains(rule, '2026-09-06T03:59:59.999Z', 'UTC', transitionCalendar)).toBe(false);
    expect(windowContains(rule, '2026-09-06T04:00:00.000Z', 'UTC', transitionCalendar)).toBe(true);
  });
});

describe('windowContains: instant bounds', () => {
  it('compares an instant with instant bounds, without the calendar', () => {
    const rule = open('2026-01-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z');
    expect(windowContains(rule, '2025-12-31T23:59:59.999Z', 'UTC', noCalendar)).toBe(false);
    expect(windowContains(rule, '2026-01-01T00:00:00.000Z', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '2026-06-30T23:59:59.999Z', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '2026-07-01T00:00:00.000Z', 'UTC', noCalendar)).toBe(false);
  });

  it('compares a civil date only when the bound is the start of that day', () => {
    const rule = open('2026-01-01T00:00:00.000Z');
    expect(windowContains(rule, '2026-01-01', 'UTC', fixedCalendar)).toBe(true);
    expect(windowContains(rule, '2025-12-31', 'UTC', fixedCalendar)).toBe(false);
    expect(windowContains(rule, '2026-01-01', 'Europe/Paris', fixedCalendar)).toBe('unknown');
  });

  it('decides a civil date that lies wholly before or after the bound', () => {
    // The bound is 2026-01-01 01:00 in Paris: the day of 2026-01-01 is cut, the others are not.
    const from = open('2026-01-01T00:00:00.000Z');
    expect(windowContains(from, '2025-12-31', 'Europe/Paris', fixedCalendar)).toBe(false);
    expect(windowContains(from, '2026-01-02', 'Europe/Paris', fixedCalendar)).toBe(true);
    const until = open('2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(windowContains(until, '2025-12-31', 'Europe/Paris', fixedCalendar)).toBe(true);
    expect(windowContains(until, '2026-01-01', 'Europe/Paris', fixedCalendar)).toBe('unknown');
    expect(windowContains(until, '2026-01-02', 'Europe/Paris', fixedCalendar)).toBe(false);
  });

  it('excludes an instant until that starts the civil day', () => {
    const rule = open('2025-01-01T00:00:00.000Z', '2025-12-31T23:00:00.000Z');
    expect(windowContains(rule, '2025-12-31', 'Europe/Paris', fixedCalendar)).toBe(true);
    expect(windowContains(rule, '2026-01-01', 'Europe/Paris', fixedCalendar)).toBe(false);
  });

  it('on a day without midnight, its first instant is the start of the day', () => {
    const rule = open('2026-09-06T04:00:00.000Z', null, 'America/Santiago');
    expect(windowContains(rule, '2026-09-06', 'UTC', transitionCalendar)).toBe(true);
    expect(windowContains(rule, '2026-09-05', 'UTC', transitionCalendar)).toBe(false);
    // 03:00Z would be local midnight in winter time, but is still 2026-09-05 at 23:00.
    const before = open('2026-09-06T03:00:00.000Z', null, 'America/Santiago');
    expect(windowContains(before, '2026-09-05', 'UTC', transitionCalendar)).toBe('unknown');
    expect(windowContains(before, '2026-09-06', 'UTC', transitionCalendar)).toBe(true);
  });
});

describe('windowContains: accepted forms', () => {
  it('reads every form toReferenceDate accepts, Date bounds included', () => {
    const rule = { effectiveFrom: new Date('2026-01-01T00:00:00Z'), effectiveUntil: undefined };
    expect(windowContains(rule, '2026-01-01T01:00:00+01:00', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '2025-12-31T23:59:59Z', 'UTC', noCalendar)).toBe(false);
  });

  it('works at the edges of the years 0000 to 9999', () => {
    const rule = open('0000-01-01', '9999-12-31');
    expect(windowContains(rule, '0000-01-01', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '9999-12-30', 'UTC', noCalendar)).toBe(true);
    expect(windowContains(rule, '9999-12-31', 'UTC', noCalendar)).toBe(false);
    expect(windowContains(rule, '0000-01-01T00:00:00.000Z', 'UTC', fixedCalendar)).toBe(true);
  });
});

describe('windowContains: the edges of the years 0000 and 9999', () => {
  it('a local day before 0000-01-01 is before every civil bound', () => {
    const rule = open('0000-01-01', null, '-01:00');
    expect(windowContains(rule, '0000-01-01T00:30:00.000Z', 'UTC', fixedCalendar)).toBe(false);
    expect(windowContains(rule, '0000-01-01T01:00:00.000Z', 'UTC', fixedCalendar)).toBe(true);
  });

  it('a local day after 9999-12-31 is after every civil bound', () => {
    const rule = open('2026-01-01', '9999-12-31', '+01:00');
    expect(windowContains(rule, '9999-12-30T22:59:59.999Z', 'UTC', fixedCalendar)).toBe(true);
    expect(windowContains(rule, '9999-12-31T23:30:00.000Z', 'UTC', fixedCalendar)).toBe(false);
    const open9999 = open('9999-12-31', null, '+01:00');
    expect(windowContains(open9999, '9999-12-31T23:30:00.000Z', 'UTC', fixedCalendar)).toBe(true);
  });

  it('an instant bound whose local day is out of range still compares with a civil date', () => {
    // In -01:00, 0000-01-01T00:00Z is -0001-12-31 23:00: the bound is before 0000-01-01.
    const before = open('0000-01-01T00:00:00.000Z', null, '-01:00');
    expect(windowContains(before, '0000-01-01', 'UTC', fixedCalendar)).toBe(true);
    // In +01:00, the day 0000-01-01 starts at -0001-12-31T23:00Z: 00:00Z does not start it.
    const cut = open('0000-01-01T00:00:00.000Z', null, '+01:00');
    expect(windowContains(cut, '0000-01-01', 'UTC', fixedCalendar)).toBe('unknown');
    expect(windowContains(cut, '0000-01-02', 'UTC', fixedCalendar)).toBe(true);
    const until = open('2026-01-01T00:00:00.000Z', '9999-12-31T23:30:00.000Z', '+01:00');
    expect(windowContains(until, '9999-12-31', 'UTC', fixedCalendar)).toBe(true);
  });

  it('isEffectiveAt decides instead of throwing', () => {
    const early = { effectiveFrom: '0000-01-01', effectiveUntil: null, timeZone: '-01:00' };
    expect(isEffectiveAt(early, new Date('0000-01-01T00:30:00.000Z'))).toBe(false);
    const late = { effectiveFrom: '2026-01-01', effectiveUntil: '9999-12-31', timeZone: '+01:00' };
    expect(isEffectiveAt(late, new Date('9999-12-31T23:30:00.000Z'))).toBe(false);
  });

  it('refuses an expanded calendar answer that is in fact in range', () => {
    const lying: CivilCalendar = { ...fixedCalendar, toCivilDate: () => '+002026-01-01' };
    expect(
      specError(() => windowContains(open('2026-01-01'), '2026-01-01T00:00:00.000Z', 'UTC', lying))
        .code,
    ).toBe('INVALID_DATE');
  });
});

describe('windowContains: refusals', () => {
  const rule = open('2026-01-01');
  const zones = 'UTC, ±HH:MM or an IANA name Area/Location';

  it('refuses an invalid time zone argument with INVALID_DATE', () => {
    for (const zone of ['Paris', '+24:00', '']) {
      const error = specError(() => windowContains(rule, '2026-01-01', zone, fixedCalendar));
      expect(error.code).toBe('INVALID_DATE');
      expect(error.message).toBe(`timeZone must be ${zones}; got ${JSON.stringify(zone)}`);
    }
  });

  it("refuses an invalid rule's time zone with INVALID_RULE", () => {
    const error = specError(() =>
      windowContains(open('2026-01-01', null, 'europe/paris'), '2026-01-01', 'UTC', noCalendar),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(`timeZone must be ${zones}; got "europe/paris"`);
  });

  it('refuses a rule mixing a civil bound and an instant bound', () => {
    const error = specError(() =>
      windowContains(
        open('2025-01-01', '2026-01-01T00:00:00.000Z'),
        '2025-06-01',
        'UTC',
        noCalendar,
      ),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(
      'effectiveFrom and effectiveUntil must both be civil dates or both instants',
    );
  });

  it('refuses an empty window', () => {
    const error = specError(() =>
      windowContains(open('2026-01-01', '2026-01-01'), '2026-01-01', 'UTC', noCalendar),
    );
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe(
      'effectiveUntil (2026-01-01) must be after effectiveFrom (2026-01-01): ' +
        'the window [effectiveFrom, effectiveUntil) would be empty',
    );
  });

  it('refuses an invalid date, bound or reference', () => {
    const at = specError(() => windowContains(rule, '2026-02-30', 'UTC', noCalendar));
    expect(at.code).toBe('INVALID_DATE');
    expect(at.message.startsWith('at must be a Date, a civil date')).toBe(true);
    const from = specError(() =>
      windowContains(open('2026-01-01T00:00Z'), '2026-01-01', 'UTC', noCalendar),
    );
    expect(from.code).toBe('INVALID_DATE');
    expect(from.message.startsWith('effectiveFrom must be a Date, a civil date')).toBe(true);
  });

  it('refuses a calendar result that is not a civil date or a canonical instant', () => {
    const bad: CivilCalendar = {
      toCivilDate: () => '2026-1-1',
      startOfDay: () => '2026-01-01T00:00:00Z',
    };
    const civil = specError(() => windowContains(rule, '2026-01-01T00:00:00.000Z', 'UTC', bad));
    expect(civil.code).toBe('INVALID_DATE');
    expect(civil.message).toBe(
      'calendar.toCivilDate returned "2026-1-1" for 2026-01-01T00:00:00.000Z in UTC: ' +
        'not a civil date YYYY-MM-DD',
    );
    const startBad: CivilCalendar = { ...fixedCalendar, startOfDay: bad.startOfDay };
    const start = specError(() =>
      windowContains(open('2026-01-01T00:00:00.000Z'), '2026-01-01', 'UTC', startBad),
    );
    expect(start.message).toBe(
      'calendar.startOfDay returned "2026-01-01T00:00:00Z" for 2026-01-01 in UTC: ' +
        'not a canonical instant YYYY-MM-DDTHH:MM:SS.sssZ',
    );
  });

  it('turns a calendar that throws into INVALID_DATE, keeping the message of its SpecError', () => {
    const throwing: CivilCalendar = {
      toCivilDate: () => {
        throw new Error('no data for "Europe/Paris"');
      },
      startOfDay: () => {
        throw new SpecError('INVALID_RULE', 'own error');
      },
    };
    const error = specError(() =>
      windowContains(rule, '2026-01-01T00:00:00.000Z', 'Europe/Paris', throwing),
    );
    expect(error.code).toBe('INVALID_DATE');
    expect(error.message).toBe(
      'calendar.toCivilDate failed for 2026-01-01T00:00:00.000Z in Europe/Paris: ' +
        'no data for \\"Europe/Paris\\"',
    );
    expect(
      specError(() =>
        windowContains(open('2026-01-01T00:00:00.000Z'), '2026-01-01', 'UTC', {
          ...fixedCalendar,
          startOfDay: throwing.startOfDay,
        }),
      ),
    ).toMatchObject({ code: 'INVALID_DATE', message: 'own error' });
  });

  it('refuses a calendar without its functions, or unreadable', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const calendar of [{}, null, proxy]) {
      const error = specError(() =>
        windowContains(rule, '2026-01-01T00:00:00.000Z', 'UTC', calendar as CivilCalendar),
      );
      expect(error.code).toBe('INVALID_DATE');
      expect(error.message.startsWith('calendar.toCivilDate ')).toBe(true);
    }
  });

  it('refuses an unreadable rule with INVALID_RULE', () => {
    const hostile = {
      get effectiveFrom(): string {
        throw new Error('boom');
      },
      effectiveUntil: null,
    };
    const error = specError(() => windowContains(hostile, '2026-01-01', 'UTC', noCalendar));
    expect(error.code).toBe('INVALID_RULE');
    expect(error.message).toBe('rule could not be read: boom');
  });
});
