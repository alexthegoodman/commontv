import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export interface Theme {
  name: string;
  displayName: string;
  description: string;
  cssFile: string;
  author: string;
  version: string;
}

export class ThemeManager {
  private currentTheme?: Theme;
  private appliedStyleSheets: Set<any> = new Set();
  private themesPath: string;
  private isShellContext: boolean = false;

  constructor(extensionPath: string, isShellContext: boolean = false) {
    this.themesPath = GLib.build_filenamev([extensionPath, 'themes']);
    this.isShellContext = isShellContext;
  }

  getAvailableThemes(): Theme[] {
    const themes: Theme[] = [
      {
        name: 'tv-futuristic',
        displayName: 'TV Futuristic',
        description: 'Futuristic blue theme optimized for TV viewing with larger buttons and text for touchpad navigation',
        cssFile: 'tv-futuristic.css',
        author: 'CommonTV',
        version: '1.0.0'
      },
      {
        name: 'default',
        displayName: 'Default',
        description: 'Default CommonTV theme with standard sizing',
        cssFile: '', // No CSS file for default theme
        author: 'CommonTV',
        version: '1.0.0'
      }
    ];

    return themes.filter(theme => {
      if (theme.cssFile === '') return true; // Default theme
      const cssPath = GLib.build_filenamev([this.themesPath, theme.cssFile]);
      console.log(`CommonTV: Checking theme file: ${cssPath}`);
      const file = Gio.File.new_for_path(cssPath);
      const exists = file.query_exists(null);
      console.log(`CommonTV: Theme ${theme.name} exists: ${exists}`);
      return exists;
    });
  }

  getCurrentTheme(): Theme | undefined {
    return this.currentTheme;
  }

  applyTheme(themeName: string): boolean {
    const themes = this.getAvailableThemes();
    const theme = themes.find(t => t.name === themeName);
    
    if (!theme) {
      console.error(`CommonTV: Theme '${themeName}' not found`);
      return false;
    }

    // Remove current theme first
    this.removeCurrentTheme();

    if (theme.cssFile === '') {
      // Default theme - no CSS to apply
      this.currentTheme = theme;
      return true;
    }

    try {
      const cssPath = GLib.build_filenamev([this.themesPath, theme.cssFile]);
      const cssFile = Gio.File.new_for_path(cssPath);
      
      if (!cssFile.query_exists(null)) {
        console.error(`CommonTV: Theme CSS file not found: ${cssPath}`);
        return false;
      }

      // Load and apply the CSS
      const [success, contents] = cssFile.load_contents(null);
      if (!success) {
        console.error(`CommonTV: Failed to load theme CSS: ${cssPath}`);
        return false;
      }

      const cssContent = new TextDecoder().decode(contents);
      console.log(`CommonTV: Loaded CSS content, length: ${cssContent.length}`);
      this.applyCSS(cssContent);
      
      this.currentTheme = theme;
      console.log(`CommonTV: Applied theme '${theme.displayName}'`);
      return true;
      
    } catch (error) {
      console.error(`CommonTV: Error applying theme '${themeName}':`, error);
      return false;
    }
  }

  private applyCSS(cssContent: string): void {
    if (!this.isShellContext) {
      console.log('CommonTV: CSS application skipped - not in shell context');
      return;
    }
    
    console.log('CommonTV: Applying CSS to shell theme...');
    try {
      // Dynamically import St only in shell context
      const St = imports.gi.St;
      
      // Create a temporary CSS file in user cache
      const cacheDir = GLib.get_user_cache_dir();
      const tempDir = GLib.build_filenamev([cacheDir, 'commontv']);
      GLib.mkdir_with_parents(tempDir, 0o755);
      
      const tempCssPath = GLib.build_filenamev([tempDir, 'current-theme.css']);
      const tempFile = Gio.File.new_for_path(tempCssPath) as any;
      
      tempFile.replace_contents(
        new TextEncoder().encode(cssContent),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
      );

      // Apply to GNOME Shell theme
      const theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
      theme.load_stylesheet(tempFile);
      this.appliedStyleSheets.add(theme);
      console.log('CommonTV: CSS stylesheet loaded successfully');
      
    } catch (error) {
      console.error('CommonTV: Error applying CSS:', error);
    }
  }

  removeCurrentTheme(): void {
    if (this.appliedStyleSheets.size > 0) {
      this.appliedStyleSheets.forEach(theme => {
        try {
          // Remove all stylesheets added by this extension
          const cacheDir = GLib.get_user_cache_dir();
          const tempCssPath = GLib.build_filenamev([cacheDir, 'commontv', 'current-theme.css']);
          const tempFile = Gio.File.new_for_path(tempCssPath) as any;
          theme.unload_stylesheet(tempFile);
        } catch (error) {
          console.warn('CommonTV: Error removing stylesheet:', error);
        }
      });
      this.appliedStyleSheets.clear();
    }
    
    this.currentTheme = undefined;
  }

  addThemeClasses(actor: any, windowType: 'main' | 'card'): void {
    if (!this.currentTheme || this.currentTheme.name === 'default' || !this.isShellContext) {
      return;
    }

    // Add base theme class
    actor.add_style_class_name('commontv-themed');
    
    // Add window type specific class
    if (windowType === 'main') {
      actor.add_style_class_name('commontv-main-window');
    } else {
      actor.add_style_class_name('commontv-card-window');
    }

    // Add theme-specific classes
    if (this.currentTheme.name === 'tv-futuristic') {
      actor.add_style_class_name('commontv-holographic');
      actor.add_style_class_name('commontv-grid-bg');
      actor.add_style_class_name('commontv-glow-pulse');
    }
  }

  createThemedButton(text: string, onClick?: () => void): any {
    if (!this.isShellContext) {
      return null;
    }
    
    const St = imports.gi.St;
    const button = new St.Button({
      label: text,
      style_class: 'commontv-button commontv-focusable',
      can_focus: true,
      track_hover: true
    });

    if (onClick) {
      button.connect('clicked', onClick);
    }

    return button;
  }

  createThemedLabel(text: string, size: 'small' | 'medium' | 'large' = 'medium'): any {
    if (!this.isShellContext) {
      return null;
    }
    
    const St = imports.gi.St;
    const label = new St.Label({
      text: text,
      style_class: `commontv-text-${size}`
    });

    return label;
  }

  getThemeColors(): { primary: string; secondary: string; accent: string } {
    if (!this.currentTheme) {
      return { primary: '#ffffff', secondary: '#cccccc', accent: '#0066cc' };
    }

    switch (this.currentTheme.name) {
      case 'tv-futuristic':
        return { primary: '#00d4ff', secondary: '#00aaff', accent: '#00ffff' };
      default:
        return { primary: '#ffffff', secondary: '#cccccc', accent: '#0066cc' };
    }
  }

  cleanup(): void {
    this.removeCurrentTheme();
  }
}