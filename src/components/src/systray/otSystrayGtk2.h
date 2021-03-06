#ifndef _otSYSTRAYGTK2_H_
#define _otSYSTRAYGTK2_H_

#include "otSystrayBase.h"
#include <gtk/gtk.h>

class otSystrayGtk2 : public otSystrayBase
{
public:
  NS_DECL_ISUPPORTS

  otSystrayGtk2();

  NS_IMETHOD Init(otISystrayListener *listener);
  NS_IMETHOD Hide();
  NS_IMETHOD SetTooltip(const nsAString &tooltip);
private:
  ~otSystrayGtk2();
protected:
  static PRBool OnClick(otSystrayGtk2 *obj, GdkEventButton *ev);

  nsresult ProcessImageData(PRInt32 width, PRInt32 height,
                            PRUint8 *rgbData, PRUint32 rgbStride,
                            PRUint32 rgbLen, PRUint8 *alphaData,
                            PRUint32 alphaStride, PRUint32 alphaBits,
                            PRBool reversed);

  GtkStatusIcon *mStatusIcon;
};

#endif
