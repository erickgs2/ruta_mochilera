import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PageHeaderComponent } from './page-header.component';

@Component({
  standalone: true,
  imports: [PageHeaderComponent],
  template: `
    <rm-page-header [title]="'Roles'">
      <button class="new-role-button">New role</button>
    </rm-page-header>
  `,
})
class HostComponent {}

describe('PageHeaderComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders the given title', () => {
    const heading = (fixture.nativeElement as HTMLElement).querySelector('.rm-page-header__title');
    expect(heading?.textContent?.trim()).toBe('Roles');
  });

  it('projects actions content into the actions slot', () => {
    const button = (fixture.nativeElement as HTMLElement).querySelector('.new-role-button');
    expect(button?.textContent?.trim()).toBe('New role');
  });
});
