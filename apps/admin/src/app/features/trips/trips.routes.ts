import { Component } from '@angular/core';
import type { Routes } from '@angular/router';

/**
 * Placeholder screen -- Task 17 replaces this with the real trip catalog
 * list/detail. It only needs to exist so `trip.view`-gated navigation in
 * the Task 16 shell has somewhere to land.
 */
@Component({ selector: 'rm-trips-placeholder', standalone: true, template: `<p>Trips</p>` })
class TripsPlaceholderComponent {}

export const tripsRoutes: Routes = [{ path: '', component: TripsPlaceholderComponent }];
