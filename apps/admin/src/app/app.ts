import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/** Root shell: everything else is routed -- see `app.routes.ts`. */
@Component({
  imports: [RouterOutlet],
  selector: 'rm-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
