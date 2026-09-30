import { Component, forwardRef, input, output, signal } from '@angular/core';
import { type ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

/**
 * A `ControlValueAccessor` that shows an amount to the user in pesos while
 * the bound `FormControl` always carries integer MXN cents (see CLAUDE.md:
 * money is never `Float` or `Decimal`). Every screen that captures money --
 * budget items, margins, deposits, manual prices -- routes through this
 * component instead of parsing a raw text input by hand, so the peso/cents
 * conversion happens exactly once, in one tested place.
 *
 * The displayed text is free-form while the user types (so "1,250.50" and
 * "1250.5" both work), but what leaves this component through `onChange` is
 * always `Math.round(pesos * 100)` -- never a fractional cent, and never a
 * negative number: a negative amount reaching `roundUpToPeso` elsewhere in
 * this workspace would round *toward* zero instead of away from it (see
 * `@rm/shared-utils`).
 *
 * A value that starts with a minus sign is **rejected outright as zero**,
 * not silently made positive: an earlier version of `parseToCents` stripped
 * the `-` character along with every other non-digit before parsing, which
 * turned "-1,250.50" into the *positive* 125,050 cents -- the opposite of
 * "never a negative number", and a worse bug than letting the minus through
 * would have been, since nothing about that result looks wrong at a glance.
 * Rejecting the whole input the moment a leading `-` is seen is what keeps a
 * mistyped negative from ever being reinterpreted as a real, larger-than-
 * intended positive amount.
 */
@Component({
  selector: 'rm-money-input',
  standalone: true,
  imports: [FormsModule, MatFormFieldModule, MatInputModule],
  template: `
    <mat-form-field appearance="outline" class="rm-money-input">
      @if (label()) {
        <mat-label>{{ label() }}</mat-label>
      }
      @if (prefix()) {
        <span matTextPrefix>{{ prefix() }}&nbsp;</span>
      }
      <input
        matInput
        type="text"
        inputmode="decimal"
        [value]="displayValue()"
        [disabled]="disabled()"
        (input)="onInput($event)"
        (blur)="onBlur()"
      />
      @if (suffix()) {
        <span matTextSuffix>&nbsp;{{ suffix() }}</span>
      }
      @if (hint()) {
        <mat-hint>{{ hint() }}</mat-hint>
      }
    </mat-form-field>
  `,
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => MoneyInputComponent), multi: true }],
})
export class MoneyInputComponent implements ControlValueAccessor {
  /** Already-translated field label, e.g. `{{ 'costing.budgetUnitAmountLabel' | translate }}`. */
  readonly label = input<string>('');
  /** Text shown before the input, e.g. "$". Empty hides it entirely. */
  readonly prefix = input<string>('$');
  /** Text shown after the input, e.g. "MXN". Empty hides it entirely. */
  readonly suffix = input<string>('MXN');
  /** Already-translated helper text below the field. */
  readonly hint = input<string>('');

  /**
   * Emitted when the inner input loses focus -- in addition to, not instead
   * of, the CVA's own `onTouched` callback. A caller such as the costing
   * screen's editable budget table wants to commit an edit on blur (one
   * request per edit, not one per keystroke); a native `(blur)` bound
   * directly on `<rm-money-input>` would not reliably fire for that, since
   * `blur` does not bubble and this component's host element is never
   * itself the focused element -- only the `<input>` nested inside it is.
   * This output is what lets a parent react to that blur without relying on
   * DOM event bubbling it cannot count on.
   */
  readonly committed = output<void>();

  /** The value currently shown in the text input, in pesos, as free-form text. */
  readonly displayValue = signal('0.00');
  readonly disabled = signal(false);

  private onChangeFn: (value: number) => void = () => {
    // Overwritten by registerOnChange once Angular forms wires this control up.
  };
  onTouched: () => void = () => {
    // Overwritten by registerOnTouched once Angular forms wires this control up.
  };

  writeValue(cents: number | null | undefined): void {
    const safeCents = cents ?? 0;
    this.displayValue.set((safeCents / 100).toFixed(2));
  }

  registerOnChange(fn: (value: number) => void): void {
    this.onChangeFn = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(isDisabled: boolean): void {
    this.disabled.set(isDisabled);
  }

  onInput(event: Event): void {
    this.onUserInput((event.target as HTMLInputElement).value);
  }

  onBlur(): void {
    this.onTouched();
    this.committed.emit();
  }

  /** Exposed directly (not just through the DOM event) so it is trivial to unit test. */
  onUserInput(raw: string): void {
    this.displayValue.set(raw);
    this.onChangeFn(this.parseToCents(raw));
  }

  /**
   * Converts whatever the user typed into integer cents. A value that
   * begins with a minus sign is rejected outright, as zero -- see the class
   * doc comment for why that is not the same as stripping the sign and
   * keeping the magnitude. Everything else that is not a digit or a decimal
   * point -- thousand separators, currency symbols, stray whitespace -- is
   * then stripped, so "1,250.50" and "$1250.50" parse the same. An empty or
   * non-numeric result is treated as zero.
   */
  private parseToCents(raw: string): number {
    const trimmed = raw.trim();
    if (trimmed.startsWith('-')) return 0;

    const cleaned = trimmed.replace(/[^0-9.]/g, '');
    if (cleaned === '') return 0;
    const pesos = parseFloat(cleaned);
    if (!Number.isFinite(pesos) || pesos <= 0) return 0;
    return Math.round(pesos * 100);
  }
}
