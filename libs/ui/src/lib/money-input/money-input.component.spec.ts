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
    // $0.015 rounds to the nearest cent (2), not just "some integer" -- an
    // exact assertion here, not merely `Number.isInteger`, so a rounding
    // regression that still happens to land on a whole number cannot pass.
    expect(emitted).toBe(2);
    expect(Number.isInteger(emitted)).toBe(true);
  });

  it('treats a null value written to the control as zero pesos', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    fixture.componentInstance.writeValue(null);
    expect(fixture.componentInstance.displayValue()).toBe('0.00');
  });

  it('rejects a value that starts with a minus sign, as zero -- not as the positive magnitude', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    let emitted: number | null = null;
    fixture.componentInstance.registerOnChange((value: number) => (emitted = value));

    // Stripping the `-` and keeping "1250.50" would satisfy a bound check
    // like `emitted >= 0` while silently turning a typo into the *opposite*,
    // larger amount -- exactly the regression this exact assertion (not a
    // `>= 0` bound either value would satisfy) is here to catch.
    fixture.componentInstance.onUserInput('-1,250.50');

    expect(emitted).toBe(0);
  });

  it('respects the disabled state set by the form', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    fixture.componentInstance.setDisabledState(true);
    expect(fixture.componentInstance.disabled()).toBe(true);
  });

  it('emits committed and calls onTouched when the field is blurred', () => {
    const fixture = TestBed.createComponent(MoneyInputComponent);
    const component = fixture.componentInstance;
    const touched = jest.fn();
    let committedCount = 0;
    component.registerOnTouched(touched);
    component.committed.subscribe(() => committedCount++);

    component.onBlur();

    expect(touched).toHaveBeenCalledTimes(1);
    expect(committedCount).toBe(1);
  });
});
