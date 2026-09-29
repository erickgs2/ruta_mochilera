import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTranslateService } from '@ngx-translate/core';
import { ImageUploaderComponent, type UploaderImage } from './image-uploader.component';

@Component({
  standalone: true,
  imports: [ImageUploaderComponent],
  template: `
    <rm-image-uploader
      [images]="images()"
      (filesSelected)="lastSelection = $event"
      (deleteRequested)="lastDeleteRequest = $event"
    ></rm-image-uploader>
  `,
})
class HostComponent {
  readonly images = signal<UploaderImage[]>([]);
  lastSelection: File[] | null = null;
  lastDeleteRequest: string | null = null;
}

function fileOf(type: string, sizeBytes: number): File {
  return new File([new Uint8Array(sizeBytes)], 'photo', { type });
}

describe('ImageUploaderComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideTranslateService({ lang: 'es', fallbackLang: 'es' })],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  function uploader(): ImageUploaderComponent {
    return fixture.debugElement.children[0].componentInstance as ImageUploaderComponent;
  }

  it('emits accepted files matching the allowed types and size', () => {
    const file = fileOf('image/png', 1024);
    uploader().onFileInputChange({ target: { files: [file], value: '' } } as unknown as Event);

    expect(host.lastSelection).toEqual([file]);
  });

  it('rejects a file with a disallowed content type on the client', () => {
    const file = fileOf('application/pdf', 1024);
    uploader().onFileInputChange({ target: { files: [file], value: '' } } as unknown as Event);

    expect(host.lastSelection).toBeNull();
    expect(uploader().rejectionKey()).toBe('images.rejectedType');
  });

  it('rejects a file over the 8 MB limit the backend also enforces', () => {
    const file = fileOf('image/jpeg', 8 * 1024 * 1024 + 1);
    uploader().onFileInputChange({ target: { files: [file], value: '' } } as unknown as Event);

    expect(host.lastSelection).toBeNull();
    expect(uploader().rejectionKey()).toBe('images.rejectedSize');
  });

  it('marks the cover image with a badge', () => {
    host.images.set([
      { id: 'img-1', url: 'https://example.test/1.jpg', isCover: true, altText: null },
      { id: 'img-2', url: 'https://example.test/2.jpg', isCover: false, altText: null },
    ]);
    fixture.detectChanges();

    const badges = (fixture.nativeElement as HTMLElement).querySelectorAll('.rm-image-uploader-cover-badge');
    expect(badges.length).toBe(1);
  });

  it('emits the image id when its delete button is clicked', () => {
    host.images.set([{ id: 'img-1', url: 'https://example.test/1.jpg', isCover: true, altText: null }]);
    fixture.detectChanges();

    uploader().requestDelete('img-1');

    expect(host.lastDeleteRequest).toBe('img-1');
  });
});
