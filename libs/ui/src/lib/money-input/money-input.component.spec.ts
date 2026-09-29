import { TestBed } from '@angular/core/testing';
import { MoneyInputComponent } from './money-input.component';

/**
 * `MoneyInputComponent` is the single conversion point between what an
 * administrator types (pesos, with or without separators) and what every
 * form in the panel actually stores and sends (integer MXN cents -- see
 * CLAUDE.md). Every test here exercises that conversion directly through the
 * `ControlValueAccessor` methods, the same way Angular's own forms machinery
 * would call them, rather than through the DOM.
 */
describe('MoneyInputComponent', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [MoneyInputComponent] });
  });

  it('emits cents when the user types pesos', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    const component = fixture.componentInstance;
    let emitted: number | null = null;
    component.registerOnChange((value: number) => (emitted = value));

    component.onUserInput('1,250.50');

    expect(emitted).toBe(125_050);
  });

  it('renders cents back as pesos', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    fixture.componentInstance.writeValue(125_050);
    expect(fixture.componentInstance.displayValue()).toBe('1250.50');
  });

  it('treats an empty field as zero', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    let emitted: number | null = null;
    fixture.componentInstance.registerOnChange((value: number) => (emitted = value));
    fixture.componentInstance.onUserInput('');
    expect(emitted).toBe(0);
  });

  it('never produces a fractional cent', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    let emitted: number | null = null;
    fixture.componentInstance.registerOnChange((value: number) => (emitted = value));
    fixture.componentInstance.onUserInput('0.015');
    expect(Number.isInteger(emitted)).toBe(true);
  });

  it('treats a null value written to the control as zero pesos', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    fixture.componentInstance.writeValue(null);
    expect(fixture.componentInstance.displayValue()).toBe('0.00');
  });

  it('never emits a negative amount, even if the user types a minus sign', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    let emitted: number | null = null;
    fixture.componentInstance.registerOnChange((value: number) => (emitted = value));

    // A stray minus sign must never reach `roundUpToPeso` downstream, which
    // rounds a negative amount toward zero instead of away from it.
    fixture.componentInstance.onUserInput('-1,250.50');

    expect(emitted).not.toBeLessThan(0);
    expect(emitted).toBeGreaterThanOrEqual(0);
  });

  it('respects the disabled state set by the form', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    fixture.componentInstance.setDisabledState(true);
    expect(fixture.componentInstance.disabled()).toBe(true);
  });
});
