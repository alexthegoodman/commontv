import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { ThemeManager } from './themes/theme-manager.js';

export default class CommonTVPreferences extends ExtensionPreferences {
  _settings?: Gio.Settings

  fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
    this._settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: _('General'),
      iconName: 'dialog-information-symbolic',
    });

    // Theme selection group
    const themeGroup = new Adw.PreferencesGroup({
      title: _('Theme'),
      description: _('Choose a theme optimized for TV viewing'),
    });
    page.add(themeGroup);

    const themeManager = new ThemeManager(this.path);
    const availableThemes = themeManager.getAvailableThemes();
    
    const themeModel = new Gtk.StringList();
    availableThemes.forEach(theme => {
      themeModel.append(theme.displayName);
    });

    const themeRow = new Adw.ComboRow({
      title: _('Theme'),
      subtitle: _('Select theme for TV viewing experience'),
      model: themeModel,
    });

    // Set initial selection
    const currentTheme = this._settings!.get_string('current-theme');
    const currentIndex = availableThemes.findIndex(theme => theme.name === currentTheme);
    if (currentIndex >= 0) {
      themeRow.set_selected(currentIndex);
    }

    // Handle theme changes
    themeRow.connect('notify::selected', () => {
      const selectedIndex = themeRow.get_selected();
      const selectedTheme = availableThemes[selectedIndex];
      if (selectedTheme) {
        this._settings!.set_string('current-theme', selectedTheme.name);
      }
    });

    themeGroup.add(themeRow);

    const animationGroup = new Adw.PreferencesGroup({
      title: _('Animation'),
      description: _('Configure move/resize animation'),
    });
    page.add(animationGroup);

    const animationEnabled = new Adw.SwitchRow({
      title: _('Enabled'),
      subtitle: _('Whether to animate windows'),
    });
    animationGroup.add(animationEnabled);

    const paddingGroup = new Adw.PreferencesGroup({
      title: _('Paddings'),
      description: _('Configure the padding between windows'),
    });
    page.add(paddingGroup);

    const paddingInner = new Adw.SpinRow({
      title: _('Inner'),
      subtitle: _('Padding between windows'),
      adjustment: new Gtk.Adjustment({
        lower: 0,
        upper: 1000,
        stepIncrement: 1
      })
    });
    paddingGroup.add(paddingInner);

    window.add(page)

    this._settings!.bind('animate', animationEnabled, 'active', Gio.SettingsBindFlags.DEFAULT);
    this._settings!.bind('padding-inner', paddingInner, 'value', Gio.SettingsBindFlags.DEFAULT);

    return Promise.resolve();
  }
}