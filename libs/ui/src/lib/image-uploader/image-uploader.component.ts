import { Component, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslatePipe } from '@ngx-translate/core';

export interface UploaderImage {
  id: string;
  url: string;
  isCover: boolean;
  altText: string | null;
}

/** The three formats the backend accepts, sniffed by magic bytes on the server (see `images/route.ts`). */
const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Drag-and-drop gallery manager: a drop zone, a grid of previews with a
 * "cover" badge on the first image, and a delete button per image.
 *
 * Rejects, on the client, exactly the two things the server also rejects --
 * an unsupported MIME type and a file over 8 MB (see `MAX_BYTES` in
 * `apps/api/.../trips/[tripId]/images/route.ts`) -- so a user gets instant
 * feedback instead of waiting on a round trip for a mistake this component
 * can already see. This is a courtesy only: the server sniffs the actual
 * bytes independently and never trusts this check (or the browser's
 * `File.type`, which is only a guess from the filename), so a spoofed file
 * that slips past this component is still caught server-side.
 *
 * Deliberately does not call any API itself: it only emits the files the
 * user dropped or picked, and the id of an image whose delete button was
 * clicked. `TripImagesComponent` owns the actual `TripsApi` calls and the
 * delete confirmation dialog, the same separation `ConfirmDialogComponent`
 * callers use elsewhere in the panel.
 */
@Component({
  selector: 'rm-image-uploader',
  standalone: true,
  imports: [MatButtonModule, MatChipsModule, MatIconModule, MatProgressSpinnerModule, TranslatePipe],
  templateUrl: './image-uploader.component.html',
  styleUrl: './image-uploader.component.scss',
})
export class ImageUploaderComponent {
  readonly images = input<UploaderImage[]>([]);
  readonly uploading = input(false);
  readonly disabled = input(false);

  readonly filesSelected = output<File[]>();
  readonly deleteRequested = output<string>();

  readonly dragOver = signal(false);
  /** Translation key for the last rejected file's reason, shown until the next drop/pick attempt. */
  readonly rejectionKey = signal<string | null>(null);

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.disabled()) this.dragOver.set(true);
  }

  onDragLeave(): void {
    this.dragOver.set(false);
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragOver.set(false);
    if (this.disabled()) return;
    this.handleFiles(event.dataTransfer?.files ?? null);
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.handleFiles(input.files);
    // Reset so selecting the same file again still fires a `change` event.
    input.value = '';
  }

  requestDelete(imageId: string): void {
    this.deleteRequested.emit(imageId);
  }

  private handleFiles(fileList: FileList | null): void {
    if (!fileList || fileList.length === 0) return;

    const accepted: File[] = [];
    this.rejectionKey.set(null);

    for (const file of Array.from(fileList)) {
      if (!ACCEPTED_TYPES.includes(file.type)) {
        this.rejectionKey.set('images.rejectedType');
        continue;
      }
      if (file.size > MAX_BYTES) {
        this.rejectionKey.set('images.rejectedSize');
        continue;
      }
      accepted.push(file);
    }

    if (accepted.length > 0) this.filesSelected.emit(accepted);
  }
}
