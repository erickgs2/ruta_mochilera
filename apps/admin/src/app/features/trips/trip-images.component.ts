import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { TranslatePipe, TranslateService } from '@ngx-translate/core';
import { TripsApi } from '@rm/api-client';
import type { components } from '@rm/api-client';
import { ConfirmDialogComponent, ErrorCodePipe, ImageUploaderComponent, PageHeaderComponent, type UploaderImage } from '@rm/ui';
import { concatMap, from, map } from 'rxjs';

type Trip = components['schemas']['Trip'];

/**
 * Manages one trip's photo gallery: upload (drag-and-drop or file picker),
 * a preview grid with a cover badge, and delete-with-confirmation. All the
 * actual drop-zone/grid UI lives in `@rm/ui`'s `ImageUploaderComponent`; this
 * component owns the `TripsApi` calls and the confirmation dialog, so the
 * presentational component stays free of both.
 *
 * `tripId` is read from `ActivatedRoute.paramMap` reactively, not from
 * `.snapshot`, for the same route-reuse reason documented on
 * `TripFormComponent`, `StaffFormComponent` and `RoleFormComponent`.
 */
@Component({
  selector: 'rm-trip-images',
  standalone: true,
  imports: [RouterLink, MatButtonModule, TranslatePipe, ErrorCodePipe, ImageUploaderComponent, PageHeaderComponent],
  templateUrl: './trip-images.component.html',
  styleUrl: './trip-images.component.scss',
  // `ErrorCodePipe` is a `@Pipe`, never `providedIn: 'root'`; listing it here
  // is what lets `inject(ErrorCodePipe)` below resolve it.
  providers: [ErrorCodePipe],
})
export class TripImagesComponent {
  private readonly tripsApi = inject(TripsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly dialog = inject(MatDialog);
  private readonly translate = inject(TranslateService);
  private readonly errorCode = inject(ErrorCodePipe);

  /** Public: the template's "back to trip" link routes to `/trips/{{ tripId() }}`. */
  readonly tripId = toSignal(this.route.paramMap.pipe(map((params) => params.get('tripId'))), {
    initialValue: this.route.snapshot.paramMap.get('tripId'),
  });

  readonly trip = signal<Trip | null>(null);
  readonly images = signal<UploaderImage[]>([]);
  readonly uploading = signal(false);
  readonly uploadError = signal<unknown>(null);

  readonly tripName = computed(() => {
    const spanish = this.trip()?.translations.find((translation) => translation.locale === 'es');
    return spanish?.name ?? '';
  });

  constructor() {
    // Re-runs whenever the route id changes (see the class doc comment).
    // Declared as a plain subscription inside the constructor rather than an
    // `effect()` because the only reactive input is `tripId` itself, read
    // once per navigation through the `paramMap` subscription below.
    this.route.paramMap.subscribe((params) => {
      const tripId = params.get('tripId');
      this.trip.set(null);
      this.images.set([]);
      if (!tripId) return;
      this.loadTrip(tripId);
    });
  }

  private loadTrip(tripId: string): void {
    this.tripsApi.get(tripId).subscribe((found) => {
      if (this.tripId() !== tripId) return;
      this.applyTrip(found);
    });
  }

  private applyTrip(found: Trip): void {
    this.trip.set(found);
    // `image.url` is computed server-side (see `withImageUrls` in
    // `apps/api/src/lib/http/trip-response.ts`): a URL is a transport
    // concern -- `local` and `s3` storage build one completely differently
    // -- so the client only ever displays what the API already sends, never
    // reconstructs one of its own.
    this.images.set(
      found.images.map((image) => ({
        id: image.id,
        url: image.url,
        isCover: image.isCover,
        altText: image.altText,
      }))
    );
  }

  onFilesSelected(files: File[]): void {
    const tripId = this.tripId();
    if (!tripId) return;

    this.uploading.set(true);
    this.uploadError.set(null);

    // Uploaded one at a time, in the order the user picked them: the first
    // image ever attached to a trip becomes its cover (see `addTripImage` in
    // `@rm/domain-trips`), so uploading in sequence rather than in parallel
    // is what makes "the first file I picked" and "the cover" the same thing.
    from(files)
      .pipe(concatMap((file) => this.tripsApi.uploadImage(tripId, file)))
      .subscribe({
        next: (uploaded) => {
          this.images.update((current) => [
            ...current,
            { id: uploaded.id, url: uploaded.url, isCover: uploaded.isCover, altText: uploaded.altText },
          ]);
        },
        error: (error: unknown) => {
          this.uploading.set(false);
          this.uploadError.set(error);
        },
        complete: () => this.uploading.set(false),
      });
  }

  onDeleteRequested(imageId: string): void {
    const tripId = this.tripId();
    if (!tripId) return;

    const ref = this.dialog.open(ConfirmDialogComponent, {
      data: {
        title: this.translate.instant('images.deleteTitle'),
        message: this.translate.instant('images.deleteMessage'),
      },
    });

    ref.afterClosed().subscribe((confirmed: boolean) => {
      if (!confirmed) return;
      this.tripsApi.deleteImage(tripId, imageId).subscribe({
        next: () => {
          // The server may have just promoted a new cover (see
          // `deleteTripImage` in `@rm/domain-trips`); its response carries no
          // body to reflect that, so the gallery is reloaded from the trip
          // rather than just splicing the deleted id out locally.
          this.loadTrip(tripId);
        },
        error: (error: unknown) => this.uploadError.set(error),
      });
    });
  }

  errorMessage(error: unknown): string {
    return this.errorCode.transform(error);
  }
}
