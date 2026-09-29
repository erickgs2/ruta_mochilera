import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { provideTranslateService } from '@ngx-translate/core';
import { ConfirmDialogComponent, type ConfirmDialogData } from './confirm-dialog.component';

describe('ConfirmDialogComponent', () => {
  let fixture: ComponentFixture<ConfirmDialogComponent>;
  let component: ConfirmDialogComponent;
  let dialogRef: { close: jest.Mock };

  const data: ConfirmDialogData = { title: 'Delete role', message: 'This cannot be undone.' };

  beforeEach(async () => {
    dialogRef = { close: jest.fn() };
    await TestBed.configureTestingModule({
      imports: [ConfirmDialogComponent],
      providers: [
        provideTranslateService(),
        { provide: MatDialogRef, useValue: dialogRef },
        { provide: MAT_DIALOG_DATA, useValue: data },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(ConfirmDialogComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('renders the provided title and message', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Delete role');
    expect(text).toContain('This cannot be undone.');
  });

  it('closes with true on confirm', () => {
    component.confirm();
    expect(dialogRef.close).toHaveBeenCalledWith(true);
  });

  it('closes with false on cancel', () => {
    component.cancel();
    expect(dialogRef.close).toHaveBeenCalledWith(false);
  });
});
