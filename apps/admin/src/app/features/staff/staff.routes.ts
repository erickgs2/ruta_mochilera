import { Component } from '@angular/core';
import type { Routes } from '@angular/router';

/**
 * Placeholder screen -- Task 17 replaces this with the real staff account
 * management screen. It only needs to exist so `staff.view`-gated
 * navigation in the Task 16 shell has somewhere to land.
 */
@Component({ selector: 'rm-staff-placeholder', standalone: true, template: `<p>Staff</p>` })
class StaffPlaceholderComponent {}

export const staffRoutes: Routes = [{ path: '', component: StaffPlaceholderComponent }];
