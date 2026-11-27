import { describe, expect, test } from 'vitest';
import { fitCommands } from '../src/pages/email/fitCommands';

describe('fitCommands (web-mail release 2 command bar)', () => {
  test('all fit; else compact; else the tail goes to the overflow and no separator is left last', () => {
    expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 400)).toEqual({ compact: false, visible: 4 });
    expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 120)).toEqual({ compact: true, visible: 4 });
    expect(fitCommands([80, 80, 10, 80], [30, 30, 10, 30], 75)).toEqual({ compact: true, visible: 2 });
  });

  test('exact fits count as fitting', () => {
    expect(fitCommands([80, 80], [30, 30], 160)).toEqual({ compact: false, visible: 2 });
    expect(fitCommands([80, 80], [30, 30], 60)).toEqual({ compact: true, visible: 2 });
  });

  test('a command that keeps its width when compact (no short form) still counts; several trailing separators all go', () => {
    expect(fitCommands([80, 60, 10, 10, 80], [30, 60, 10, 10, 30], 115)).toEqual({ compact: true, visible: 2 });
  });

  test('nothing fits: nothing visible; no commands: nothing to fit', () => {
    expect(fitCommands([80], [30], 20)).toEqual({ compact: true, visible: 0 });
    expect(fitCommands([], [], 0)).toEqual({ compact: false, visible: 0 });
  });
});
